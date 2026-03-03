/**
 * PotreeConversionService
 * 
 * Executes PotreeConverter CLI to convert LAS/LAZ files to Potree format.
 * Supports Potree 1.7 output format (cloud.js + octree bins)
 * 
 * @requires PotreeConverter installed and accessible in PATH or configured via POTREE_CONVERTER_PATH
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

const POTREE_CONVERTER_PATH = process.env.POTREE_CONVERTER_PATH || 'PotreeConverter';

const LOG_PREFIX = '[PotreeConversionService]';

class PotreeConversionService {
    constructor() {
        this.activeConversions = new Map();
    }

    /**
     * Convert a LAS/LAZ file to Potree format
     * @param {string} inputPath - Path to input LAS/LAZ file
     * @param {string} outputDir - Directory for Potree output
     * @param {Object} options - Conversion options
     * @param {function} onProgress - Progress callback (optional)
     * @returns {Promise<ConversionResult>}
     */
    async convert(inputPath, outputDir, options = {}, onProgress = null) {
        const conversionId = options.conversionId || `conv_${Date.now()}`;
        
        console.log(`${LOG_PREFIX} Starting conversion:`, {
            conversionId,
            inputPath,
            outputDir
        });

        const conversionState = {
            id: conversionId,
            status: 'running',
            progress: 0,
            startTime: Date.now(),
            inputPath,
            outputDir,
            logs: []
        };

        this.activeConversions.set(conversionId, conversionState);

        try {
            await fs.mkdir(outputDir, { recursive: true });

            const args = this._buildArgs(inputPath, outputDir, options);
            console.log(`${LOG_PREFIX} Executing: ${POTREE_CONVERTER_PATH} ${args.join(' ')}`);

            const result = await this._executeConverter(args, conversionState, onProgress);

            const validationUtils = require('./validationUtils');
            const validation = await validationUtils.validatePotreeOutput(outputDir);
            
            if (!validation.valid) {
                throw new Error(`Conversion completed but validation failed: ${validation.errors.join(', ')}`);
            }
            
            if (validation.warnings.length > 0) {
                console.warn(`${LOG_PREFIX} Validation warnings:`, validation.warnings);
            }

            conversionState.status = 'completed';
            conversionState.endTime = Date.now();
            conversionState.duration = conversionState.endTime - conversionState.startTime;

            const potreeFormat = validation.format;
            const metadataFile = potreeFormat === '2.0' ? 'metadata.json' : 'cloud.js';
            const metadataPath = path.join(outputDir, metadataFile);
            const metadata = potreeFormat === '2.0' 
                ? await this._readMetadata2(metadataPath)
                : await this._readCloudMetadata(metadataPath);
            
            metadata.potreeFormat = potreeFormat;

            console.log(`${LOG_PREFIX} Conversion completed successfully:`, {
                conversionId,
                duration: `${conversionState.duration}ms`,
                potreeFormat,
                pointAttributes: metadata.pointAttributes || metadata.attributes?.map(a => a.name),
                points: metadata.points
            });

            return {
                success: true,
                conversionId,
                outputDir,
                metadataPath,
                potreeFormat,
                metadata,
                duration: conversionState.duration,
                logs: conversionState.logs
            };

        } catch (error) {
            conversionState.status = 'failed';
            conversionState.error = error.message;
            conversionState.endTime = Date.now();

            console.error(`${LOG_PREFIX} Conversion failed:`, {
                conversionId,
                error: error.message
            });

            return {
                success: false,
                conversionId,
                error: error.message,
                logs: conversionState.logs
            };

        } finally {
            setTimeout(() => {
                this.activeConversions.delete(conversionId);
            }, 60000);
        }
    }

    /**
     * Build command line arguments for PotreeConverter
     */
    _buildArgs(inputPath, outputDir, options) {
        const args = [inputPath, '-o', outputDir];

        if (options.outputFormat) {
            args.push('-f', options.outputFormat);
        }

        if (options.spacing) {
            args.push('-s', options.spacing.toString());
        }

        if (options.maxDepth) {
            args.push('-d', options.maxDepth.toString());
        }

        if (options.outputAttributes) {
            args.push('-a', options.outputAttributes);
        }

        if (options.generatePage) {
            args.push('-p');
        }

        return args;
    }

    /**
     * Execute PotreeConverter as child process
     */
    _executeConverter(args, state, onProgress) {
        return new Promise((resolve, reject) => {
            const process = spawn(POTREE_CONVERTER_PATH, args, {
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                state.logs.push({ type: 'stdout', text, timestamp: Date.now() });

                const progress = this._parseProgress(text);
                if (progress !== null) {
                    state.progress = progress;
                    if (onProgress) {
                        onProgress(progress, text);
                    }
                }

                console.log(`${LOG_PREFIX} [stdout]`, text.trim());
            });

            process.stderr.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                state.logs.push({ type: 'stderr', text, timestamp: Date.now() });
                console.warn(`${LOG_PREFIX} [stderr]`, text.trim());
            });

            process.on('error', (error) => {
                reject(new Error(`Failed to start PotreeConverter: ${error.message}. Ensure PotreeConverter is installed and in PATH.`));
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr, code });
                } else {
                    reject(new Error(`PotreeConverter exited with code ${code}. Stderr: ${stderr}`));
                }
            });

            setTimeout(() => {
                if (state.status === 'running') {
                    process.kill('SIGTERM');
                    reject(new Error('Conversion timeout (30 minutes)'));
                }
            }, 30 * 60 * 1000);
        });
    }

    /**
     * Parse progress from PotreeConverter output
     */
    _parseProgress(text) {
        const progressMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
        if (progressMatch) {
            return parseFloat(progressMatch[1]);
        }

        const indexingMatch = text.match(/indexing:\s*(\d+)/i);
        if (indexingMatch) {
            return Math.min(50, parseInt(indexingMatch[1]) / 10000);
        }

        return null;
    }

    /**
     * Validate that conversion output is correct
     */
    async _validateOutput(outputDir) {
        try {
            const cloudJsPath = path.join(outputDir, 'cloud.js');
            const dataDir = path.join(outputDir, 'data');

            const cloudJsExists = await fs.access(cloudJsPath)
                .then(() => true)
                .catch(() => false);

            const dataDirExists = await fs.access(dataDir)
                .then(() => true)
                .catch(() => false);

            console.log(`${LOG_PREFIX} Validation:`, {
                cloudJsExists,
                dataDirExists
            });

            return cloudJsExists && dataDirExists;

        } catch (error) {
            console.error(`${LOG_PREFIX} Validation error:`, error);
            return false;
        }
    }

    /**
     * Read and parse cloud.js metadata (Potree 1.x)
     */
    async _readCloudMetadata(cloudJsPath) {
        try {
            const content = await fs.readFile(cloudJsPath, 'utf8');
            const metadata = JSON.parse(content);

            return {
                version: metadata.version,
                octreeDir: metadata.octreeDir,
                points: metadata.points,
                boundingBox: metadata.boundingBox,
                tightBoundingBox: metadata.tightBoundingBox,
                pointAttributes: metadata.pointAttributes,
                spacing: metadata.spacing,
                scale: metadata.scale,
                hierarchyStepSize: metadata.hierarchyStepSize
            };

        } catch (error) {
            console.warn(`${LOG_PREFIX} Could not read cloud.js metadata:`, error.message);
            return {};
        }
    }

    /**
     * Read and parse metadata.json (Potree 2.x)
     */
    async _readMetadata2(metadataPath) {
        try {
            const content = await fs.readFile(metadataPath, 'utf8');
            const metadata = JSON.parse(content);

            return {
                version: metadata.version,
                name: metadata.name,
                points: metadata.points,
                boundingBox: metadata.boundingBox,
                offset: metadata.offset,
                scale: metadata.scale,
                spacing: metadata.spacing,
                encoding: metadata.encoding,
                hierarchy: metadata.hierarchy,
                attributes: metadata.attributes
            };

        } catch (error) {
            console.warn(`${LOG_PREFIX} Could not read metadata.json:`, error.message);
            return {};
        }
    }

    /**
     * Get status of an active conversion
     */
    getConversionStatus(conversionId) {
        const state = this.activeConversions.get(conversionId);
        if (!state) {
            return null;
        }

        return {
            id: state.id,
            status: state.status,
            progress: state.progress,
            startTime: state.startTime,
            endTime: state.endTime,
            duration: state.endTime ? state.endTime - state.startTime : Date.now() - state.startTime,
            error: state.error
        };
    }

    /**
     * Get all active conversions
     */
    getActiveConversions() {
        const conversions = [];
        for (const [id, state] of this.activeConversions) {
            conversions.push({
                id,
                status: state.status,
                progress: state.progress,
                startTime: state.startTime
            });
        }
        return conversions;
    }

    /**
     * Check if PotreeConverter is available
     */
    async checkConverterAvailable() {
        return new Promise((resolve) => {
            const process = spawn(POTREE_CONVERTER_PATH, ['--help'], {
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            process.on('error', () => resolve(false));
            process.on('close', (code) => resolve(code === 0));

            setTimeout(() => {
                process.kill();
                resolve(false);
            }, 5000);
        });
    }
}

module.exports = new PotreeConversionService();
