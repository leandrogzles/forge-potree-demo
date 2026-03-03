/**
 * DatasetStorageService
 * 
 * Manages storage for converted Potree datasets.
 * Supports local filesystem and S3 storage backends.
 * 
 * Storage structure:
 *   /datasets/{datasetId}/cloud.js
 *   /datasets/{datasetId}/data/r/r.hrc
 *   /datasets/{datasetId}/data/r/r.bin
 *   /datasets/{datasetId}/data/r/r0.bin
 *   ...
 */

const path = require('path');
const fs = require('fs').promises;
const { createReadStream, createWriteStream } = require('fs');

const LOG_PREFIX = '[DatasetStorageService]';

const STORAGE_TYPE = process.env.STORAGE_TYPE || 'local';
const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH || path.join(__dirname, '..', 'public', 'datasets');
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_PREFIX = process.env.S3_PREFIX || 'potree-datasets';

class DatasetStorageService {
    constructor() {
        this.storageType = STORAGE_TYPE;
        this.localPath = LOCAL_STORAGE_PATH;
        this.s3Client = null;
        
        if (this.storageType === 's3') {
            this._initS3Client();
        }
    }

    /**
     * Initialize S3 client (if using S3 storage)
     */
    _initS3Client() {
        try {
            const { S3Client } = require('@aws-sdk/client-s3');
            this.s3Client = new S3Client({ region: S3_REGION });
            console.log(`${LOG_PREFIX} S3 client initialized for bucket: ${S3_BUCKET}`);
        } catch (error) {
            console.warn(`${LOG_PREFIX} S3 SDK not available, falling back to local storage`);
            this.storageType = 'local';
        }
    }

    /**
     * Get the output directory path for a dataset (for conversion)
     */
    getOutputPath(datasetId) {
        return path.join(this.localPath, datasetId);
    }

    /**
     * Get the temporary directory path for processing
     */
    getTempPath(datasetId) {
        const tempBase = process.env.TEMP_PATH || path.join(__dirname, '..', 'temp');
        return path.join(tempBase, datasetId);
    }

    /**
     * Store a converted dataset
     * If using S3, uploads from local temp to S3
     * If using local, moves from temp to final location
     * @param {string} potreeFormat - '1.x' or '2.0'
     */
    async storeDataset(datasetId, sourcePath, potreeFormat = '1.x') {
        console.log(`${LOG_PREFIX} Storing dataset:`, { datasetId, sourcePath, storageType: this.storageType, potreeFormat });

        if (this.storageType === 's3') {
            return await this._storeToS3(datasetId, sourcePath, potreeFormat);
        } else {
            return await this._storeToLocal(datasetId, sourcePath, potreeFormat);
        }
    }

    /**
     * Store dataset to local filesystem
     */
    async _storeToLocal(datasetId, sourcePath, potreeFormat = '1.x') {
        const destPath = this.getOutputPath(datasetId);
        
        const metadataFile = potreeFormat === '2.0' ? 'metadata.json' : 'cloud.js';
        const metadataUrl = `/datasets/${datasetId}/${metadataFile}`;
        
        if (sourcePath === destPath) {
            console.log(`${LOG_PREFIX} Dataset already in final location:`, destPath);
            return {
                type: 'local',
                datasetId,
                path: destPath,
                potreeFormat,
                metadataUrl,
                cloudJsUrl: metadataUrl
            };
        }

        await fs.mkdir(path.dirname(destPath), { recursive: true });

        const sourceExists = await fs.access(sourcePath).then(() => true).catch(() => false);
        if (!sourceExists) {
            throw new Error(`Source path does not exist: ${sourcePath}`);
        }

        await this._copyDirectory(sourcePath, destPath);

        console.log(`${LOG_PREFIX} Dataset stored locally:`, destPath);

        return {
            type: 'local',
            datasetId,
            path: destPath,
            potreeFormat,
            metadataUrl,
            cloudJsUrl: metadataUrl
        };
    }

    /**
     * Store dataset to S3
     */
    async _storeToS3(datasetId, sourcePath) {
        if (!this.s3Client) {
            throw new Error('S3 client not initialized');
        }

        const { Upload } = require('@aws-sdk/lib-storage');
        const { PutObjectCommand } = require('@aws-sdk/client-s3');

        const files = await this._listFilesRecursive(sourcePath);
        console.log(`${LOG_PREFIX} Uploading ${files.length} files to S3...`);

        for (const filePath of files) {
            const relativePath = path.relative(sourcePath, filePath);
            const s3Key = `${S3_PREFIX}/${datasetId}/${relativePath}`.replace(/\\/g, '/');
            
            const fileStream = createReadStream(filePath);
            const upload = new Upload({
                client: this.s3Client,
                params: {
                    Bucket: S3_BUCKET,
                    Key: s3Key,
                    Body: fileStream,
                    ContentType: this._getContentType(filePath)
                }
            });

            await upload.done();
        }

        const cloudJsUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_PREFIX}/${datasetId}/cloud.js`;
        
        console.log(`${LOG_PREFIX} Dataset uploaded to S3:`, cloudJsUrl);

        return {
            type: 's3',
            datasetId,
            bucket: S3_BUCKET,
            prefix: `${S3_PREFIX}/${datasetId}`,
            cloudJsUrl
        };
    }

    /**
     * Delete a dataset
     */
    async deleteDataset(datasetId) {
        console.log(`${LOG_PREFIX} Deleting dataset:`, datasetId);

        if (this.storageType === 's3') {
            return await this._deleteFromS3(datasetId);
        } else {
            return await this._deleteFromLocal(datasetId);
        }
    }

    /**
     * Delete dataset from local filesystem
     */
    async _deleteFromLocal(datasetId) {
        const datasetPath = this.getOutputPath(datasetId);
        
        try {
            await fs.rm(datasetPath, { recursive: true, force: true });
            console.log(`${LOG_PREFIX} Dataset deleted from local:`, datasetPath);
            return true;
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to delete dataset:`, error);
            return false;
        }
    }

    /**
     * Delete dataset from S3
     */
    async _deleteFromS3(datasetId) {
        if (!this.s3Client) {
            throw new Error('S3 client not initialized');
        }

        const { DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
        
        const prefix = `${S3_PREFIX}/${datasetId}/`;
        
        const listCommand = new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: prefix
        });
        
        const listResponse = await this.s3Client.send(listCommand);
        
        if (!listResponse.Contents || listResponse.Contents.length === 0) {
            return true;
        }

        const deleteCommand = new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: {
                Objects: listResponse.Contents.map(obj => ({ Key: obj.Key }))
            }
        });

        await this.s3Client.send(deleteCommand);
        console.log(`${LOG_PREFIX} Dataset deleted from S3:`, prefix);
        
        return true;
    }

    /**
     * List all datasets
     */
    async listDatasets() {
        if (this.storageType === 's3') {
            return await this._listFromS3();
        } else {
            return await this._listFromLocal();
        }
    }

    /**
     * List datasets from local storage
     * Detects both Potree 1.x (cloud.js) and Potree 2.0 (metadata.json)
     */
    async _listFromLocal() {
        const datasets = [];
        
        try {
            const entries = await fs.readdir(this.localPath, { withFileTypes: true });
            
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const metadata2Path = path.join(this.localPath, entry.name, 'metadata.json');
                    const cloudJsPath = path.join(this.localPath, entry.name, 'cloud.js');
                    
                    const metadata2Exists = await fs.access(metadata2Path).then(() => true).catch(() => false);
                    const cloudJsExists = await fs.access(cloudJsPath).then(() => true).catch(() => false);
                    
                    if (metadata2Exists) {
                        datasets.push({
                            datasetId: entry.name,
                            cloudJsUrl: `/datasets/${entry.name}/metadata.json`,
                            potreeFormat: '2.0',
                            type: 'local'
                        });
                    } else if (cloudJsExists) {
                        datasets.push({
                            datasetId: entry.name,
                            cloudJsUrl: `/datasets/${entry.name}/cloud.js`,
                            potreeFormat: '1.x',
                            type: 'local'
                        });
                    }
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        
        return datasets;
    }

    /**
     * List datasets from S3
     */
    async _listFromS3() {
        if (!this.s3Client) {
            return [];
        }

        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        const datasets = new Map();
        
        const command = new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: S3_PREFIX + '/',
            Delimiter: '/'
        });

        const response = await this.s3Client.send(command);
        
        if (response.CommonPrefixes) {
            for (const prefix of response.CommonPrefixes) {
                const datasetId = prefix.Prefix.replace(S3_PREFIX + '/', '').replace('/', '');
                if (datasetId) {
                    datasets.set(datasetId, {
                        datasetId,
                        cloudJsUrl: `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_PREFIX}/${datasetId}/cloud.js`,
                        type: 's3'
                    });
                }
            }
        }
        
        return Array.from(datasets.values());
    }

    /**
     * Get dataset info
     * Detects both Potree 1.x (cloud.js) and Potree 2.0 (metadata.json)
     */
    async getDatasetInfo(datasetId) {
        if (this.storageType === 's3') {
            return {
                datasetId,
                cloudJsUrl: `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${S3_PREFIX}/${datasetId}/cloud.js`,
                type: 's3'
            };
        } else {
            const metadata2Path = path.join(this.localPath, datasetId, 'metadata.json');
            const cloudJsPath = path.join(this.localPath, datasetId, 'cloud.js');
            
            const metadata2Exists = await fs.access(metadata2Path).then(() => true).catch(() => false);
            const cloudJsExists = await fs.access(cloudJsPath).then(() => true).catch(() => false);
            
            if (metadata2Exists) {
                return {
                    datasetId,
                    cloudJsUrl: `/datasets/${datasetId}/metadata.json`,
                    potreeFormat: '2.0',
                    path: path.join(this.localPath, datasetId),
                    type: 'local'
                };
            } else if (cloudJsExists) {
                return {
                    datasetId,
                    cloudJsUrl: `/datasets/${datasetId}/cloud.js`,
                    potreeFormat: '1.x',
                    path: path.join(this.localPath, datasetId),
                    type: 'local'
                };
            }
            
            return null;
        }
    }

    /**
     * Clean up temporary files
     */
    async cleanupTemp(datasetId) {
        const tempPath = this.getTempPath(datasetId);
        
        try {
            await fs.rm(tempPath, { recursive: true, force: true });
            console.log(`${LOG_PREFIX} Cleaned up temp:`, tempPath);
        } catch (error) {
            console.warn(`${LOG_PREFIX} Failed to cleanup temp:`, error.message);
        }
    }

    /**
     * Recursively copy directory
     */
    async _copyDirectory(src, dest) {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                await this._copyDirectory(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }

    /**
     * Recursively list all files in directory
     */
    async _listFilesRecursive(dir) {
        const files = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                const subFiles = await this._listFilesRecursive(fullPath);
                files.push(...subFiles);
            } else {
                files.push(fullPath);
            }
        }
        
        return files;
    }

    /**
     * Get content type for file
     */
    _getContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.bin': 'application/octet-stream',
            '.hrc': 'application/octet-stream'
        };
        return types[ext] || 'application/octet-stream';
    }

    /**
     * Ensure storage directories exist
     */
    async ensureStorageExists() {
        if (this.storageType === 'local') {
            await fs.mkdir(this.localPath, { recursive: true });
            console.log(`${LOG_PREFIX} Local storage ensured:`, this.localPath);
        }
        
        const tempBase = process.env.TEMP_PATH || path.join(__dirname, '..', 'temp');
        await fs.mkdir(tempBase, { recursive: true });
        console.log(`${LOG_PREFIX} Temp storage ensured:`, tempBase);
    }
}

module.exports = new DatasetStorageService();
