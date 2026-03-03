/**
 * LAS Upload Controller
 * 
 * Handles LAS/LAZ file upload, conversion to Potree format,
 * and storage management.
 * 
 * Flow:
 * 1. User uploads .las/.laz file
 * 2. File is saved to temp directory
 * 3. PotreeConverter is executed
 * 4. Output is stored (local or S3)
 * 5. Client receives cloudJsUrl
 */

const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const potreeConversionService = require('./potreeConversionService');
const datasetStorageService = require('./datasetStorageService');

const LOG_PREFIX = '[LASUploadController]';

const MAX_FILE_SIZE = parseInt(process.env.MAX_LAS_FILE_SIZE) || 2 * 1024 * 1024 * 1024; // 2GB default
const ALLOWED_EXTENSIONS = ['.las', '.laz'];

class LASUploadController {
    constructor() {
        this.pendingUploads = new Map();
        this.conversionQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentConversions = parseInt(process.env.MAX_CONCURRENT_CONVERSIONS) || 2;
    }

    /**
     * Handle file upload request
     * @param {Object} file - Multer file object
     * @param {Object} options - Upload options
     * @returns {Promise<UploadResult>}
     */
    async handleUpload(file, options = {}) {
        const datasetId = uuidv4();
        
        console.log(`${LOG_PREFIX} Processing upload:`, {
            datasetId,
            originalName: file.originalname,
            size: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
            mimetype: file.mimetype
        });

        try {
            this._validateFile(file);

            const uploadInfo = {
                datasetId,
                status: 'queued',
                originalName: file.originalname,
                fileSize: file.size,
                uploadTime: Date.now(),
                progress: 0
            };
            this.pendingUploads.set(datasetId, uploadInfo);

            const conversionResult = await this._processConversion(file, datasetId, options);

            if (!conversionResult.success) {
                throw new Error(conversionResult.error || 'Conversion failed');
            }

            const storageResult = await datasetStorageService.storeDataset(
                datasetId,
                conversionResult.outputDir,
                conversionResult.potreeFormat
            );

            if (file.path !== storageResult.path) {
                await this._cleanupTempFile(file.path);
            }

            uploadInfo.status = 'completed';
            uploadInfo.cloudJsUrl = storageResult.cloudJsUrl;
            uploadInfo.metadata = conversionResult.metadata;
            uploadInfo.completionTime = Date.now();
            uploadInfo.totalDuration = uploadInfo.completionTime - uploadInfo.uploadTime;

            console.log(`${LOG_PREFIX} Upload completed:`, {
                datasetId,
                cloudJsUrl: storageResult.cloudJsUrl,
                potreeFormat: conversionResult.potreeFormat,
                duration: `${uploadInfo.totalDuration}ms`,
                points: conversionResult.metadata?.points
            });

            return {
                success: true,
                datasetId,
                cloudJsUrl: storageResult.cloudJsUrl,
                potreeFormat: conversionResult.potreeFormat,
                originalName: file.originalname,
                metadata: conversionResult.metadata,
                duration: uploadInfo.totalDuration
            };

        } catch (error) {
            console.error(`${LOG_PREFIX} Upload failed:`, {
                datasetId,
                error: error.message
            });

            const uploadInfo = this.pendingUploads.get(datasetId);
            if (uploadInfo) {
                uploadInfo.status = 'failed';
                uploadInfo.error = error.message;
            }

            await this._cleanupTempFile(file.path);
            await datasetStorageService.cleanupTemp(datasetId);

            return {
                success: false,
                datasetId,
                error: error.message
            };

        } finally {
            setTimeout(() => {
                this.pendingUploads.delete(datasetId);
            }, 5 * 60 * 1000);
        }
    }

    /**
     * Validate uploaded file
     */
    _validateFile(file) {
        if (!file) {
            throw new Error('No file provided');
        }

        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
        }

        if (file.size > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(2)} MB. Max: ${MAX_FILE_SIZE / 1024 / 1024} MB`);
        }

        console.log(`${LOG_PREFIX} File validated:`, {
            name: file.originalname,
            ext,
            size: file.size
        });
    }

    /**
     * Process conversion (immediate or queued)
     */
    async _processConversion(file, datasetId, options) {
        const uploadInfo = this.pendingUploads.get(datasetId);
        if (uploadInfo) {
            uploadInfo.status = 'converting';
        }

        const outputDir = datasetStorageService.getOutputPath(datasetId);

        const onProgress = (progress, message) => {
            if (uploadInfo) {
                uploadInfo.progress = progress;
                uploadInfo.lastMessage = message;
            }
        };

        const result = await potreeConversionService.convert(
            file.path,
            outputDir,
            {
                conversionId: datasetId,
                ...options.conversionOptions
            },
            onProgress
        );

        return result;
    }

    /**
     * Clean up temporary file
     */
    async _cleanupTempFile(filePath) {
        if (!filePath) return;
        
        try {
            await fs.unlink(filePath);
            console.log(`${LOG_PREFIX} Cleaned up temp file:`, filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`${LOG_PREFIX} Failed to cleanup temp file:`, error.message);
            }
        }
    }

    /**
     * Get status of an upload/conversion
     */
    getUploadStatus(datasetId) {
        const uploadInfo = this.pendingUploads.get(datasetId);
        
        if (uploadInfo) {
            return {
                datasetId,
                status: uploadInfo.status,
                progress: uploadInfo.progress,
                originalName: uploadInfo.originalName,
                fileSize: uploadInfo.fileSize,
                uploadTime: uploadInfo.uploadTime,
                cloudJsUrl: uploadInfo.cloudJsUrl,
                error: uploadInfo.error
            };
        }

        const conversionStatus = potreeConversionService.getConversionStatus(datasetId);
        if (conversionStatus) {
            return conversionStatus;
        }

        return null;
    }

    /**
     * Get all pending uploads/conversions
     */
    getPendingUploads() {
        const uploads = [];
        for (const [datasetId, info] of this.pendingUploads) {
            uploads.push({
                datasetId,
                status: info.status,
                progress: info.progress,
                originalName: info.originalName
            });
        }
        return uploads;
    }

    /**
     * Delete a dataset
     */
    async deleteDataset(datasetId) {
        return await datasetStorageService.deleteDataset(datasetId);
    }

    /**
     * List all datasets
     */
    async listDatasets() {
        return await datasetStorageService.listDatasets();
    }

    /**
     * Get dataset info
     */
    async getDatasetInfo(datasetId) {
        return await datasetStorageService.getDatasetInfo(datasetId);
    }

    /**
     * Check system health
     */
    async checkHealth() {
        const converterAvailable = await potreeConversionService.checkConverterAvailable();
        
        return {
            converterAvailable,
            storageType: datasetStorageService.storageType,
            pendingUploads: this.pendingUploads.size,
            activeConversions: potreeConversionService.getActiveConversions().length
        };
    }

    /**
     * Initialize the controller
     */
    async initialize() {
        await datasetStorageService.ensureStorageExists();
        console.log(`${LOG_PREFIX} Controller initialized`);
    }
}

module.exports = new LASUploadController();
