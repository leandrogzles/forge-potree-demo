/**
 * Validation Utilities
 * 
 * Provides validation functions for Potree conversion output.
 */

const path = require('path');
const fs = require('fs').promises;

const LOG_PREFIX = '[ValidationUtils]';

/**
 * Validate Potree conversion output
 * Supports both Potree 1.x (cloud.js) and Potree 2.x (metadata.json) formats
 * @param {string} outputDir - Directory containing Potree output
 * @returns {Promise<ValidationResult>}
 */
async function validatePotreeOutput(outputDir) {
    console.log(`${LOG_PREFIX} Validating output:`, outputDir);
    
    const result = {
        valid: true,
        format: null,
        cloudJsExists: false,
        metadataJsonExists: false,
        dataExists: false,
        hierarchyExists: false,
        binFilesCount: 0,
        metadata: null,
        errors: [],
        warnings: []
    };

    try {
        const potree2MetadataPath = path.join(outputDir, 'metadata.json');
        const potree2Exists = await fs.access(potree2MetadataPath).then(() => true).catch(() => false);
        
        if (potree2Exists) {
            result.format = '2.0';
            result.metadataJsonExists = true;
            
            try {
                const metadataContent = await fs.readFile(potree2MetadataPath, 'utf8');
                result.metadata = JSON.parse(metadataContent);
                console.log(`${LOG_PREFIX} Potree 2.0 metadata.json parsed successfully`);
                
                logMetadata2(result.metadata);
                
                const octreeBinPath = path.join(outputDir, 'octree.bin');
                const hierarchyBinPath = path.join(outputDir, 'hierarchy.bin');
                
                const octreeExists = await fs.access(octreeBinPath).then(() => true).catch(() => false);
                const hierarchyExists = await fs.access(hierarchyBinPath).then(() => true).catch(() => false);
                
                result.dataExists = octreeExists;
                result.hierarchyExists = hierarchyExists;
                
                if (!octreeExists) {
                    result.errors.push('octree.bin not found');
                    result.valid = false;
                }
                
                if (!hierarchyExists) {
                    result.errors.push('hierarchy.bin not found');
                    result.valid = false;
                }
                
                console.log(`${LOG_PREFIX} Potree 2.0 files: octree.bin=${octreeExists}, hierarchy.bin=${hierarchyExists}`);
                
            } catch (parseError) {
                result.errors.push(`metadata.json is not valid JSON: ${parseError.message}`);
                result.valid = false;
            }
            
        } else {
            const cloudJsPath = path.join(outputDir, 'cloud.js');
            try {
                const cloudJsContent = await fs.readFile(cloudJsPath, 'utf8');
                result.format = '1.x';
                result.cloudJsExists = true;
                
                try {
                    result.metadata = JSON.parse(cloudJsContent);
                    console.log(`${LOG_PREFIX} Potree 1.x cloud.js parsed successfully`);
                    
                    logMetadata(result.metadata);
                    
                } catch (parseError) {
                    result.errors.push(`cloud.js is not valid JSON: ${parseError.message}`);
                    result.valid = false;
                }
            } catch (err) {
                result.errors.push('Neither metadata.json (2.0) nor cloud.js (1.x) found');
                result.valid = false;
            }

            if (result.format === '1.x') {
                const dataDir = path.join(outputDir, 'data');
                try {
                    const dataStat = await fs.stat(dataDir);
                    if (dataStat.isDirectory()) {
                        result.dataExists = true;
                        
                        const binFiles = await findFilesRecursive(dataDir, '.bin');
                        result.binFilesCount = binFiles.length;
                        
                        if (binFiles.length === 0) {
                            result.warnings.push('No .bin files found in data directory');
                        }
                        
                        console.log(`${LOG_PREFIX} Found ${binFiles.length} .bin files`);

                        const hrcFiles = await findFilesRecursive(dataDir, '.hrc');
                        result.hierarchyExists = hrcFiles.length > 0;
                        
                        if (!result.hierarchyExists) {
                            result.warnings.push('No .hrc hierarchy files found');
                        }
                        
                        console.log(`${LOG_PREFIX} Found ${hrcFiles.length} .hrc files`);
                    }
                } catch (err) {
                    result.errors.push('data directory not found');
                    result.valid = false;
                }
            }
        }

        if (result.metadata && result.format === '1.x') {
            const metaValidation = validateMetadata(result.metadata);
            result.errors.push(...metaValidation.errors);
            result.warnings.push(...metaValidation.warnings);
            if (metaValidation.errors.length > 0) {
                result.valid = false;
            }
        }

    } catch (error) {
        result.errors.push(`Validation failed: ${error.message}`);
        result.valid = false;
    }

    console.log(`${LOG_PREFIX} Validation result:`, {
        valid: result.valid,
        format: result.format,
        cloudJsExists: result.cloudJsExists,
        metadataJsonExists: result.metadataJsonExists,
        dataExists: result.dataExists,
        errors: result.errors,
        warnings: result.warnings
    });

    return result;
}

/**
 * Log Potree 2.0 metadata information
 */
function logMetadata2(metadata) {
    console.log(`${LOG_PREFIX} === POTREE 2.0 METADATA ===`);
    console.log(`${LOG_PREFIX} Version: ${metadata.version || 'N/A'}`);
    console.log(`${LOG_PREFIX} Name: ${metadata.name || 'N/A'}`);
    console.log(`${LOG_PREFIX} Points: ${metadata.points?.toLocaleString() || 'N/A'}`);
    console.log(`${LOG_PREFIX} Encoding: ${metadata.encoding || 'N/A'}`);
    console.log(`${LOG_PREFIX} Spacing: ${metadata.spacing || 'N/A'}`);
    console.log(`${LOG_PREFIX} Scale: [${metadata.scale?.join(', ') || 'N/A'}]`);
    console.log(`${LOG_PREFIX} Offset: [${metadata.offset?.join(', ') || 'N/A'}]`);
    
    if (metadata.hierarchy) {
        console.log(`${LOG_PREFIX} Hierarchy:`);
        console.log(`${LOG_PREFIX}   firstChunkSize: ${metadata.hierarchy.firstChunkSize}`);
        console.log(`${LOG_PREFIX}   stepSize: ${metadata.hierarchy.stepSize}`);
        console.log(`${LOG_PREFIX}   depth: ${metadata.hierarchy.depth}`);
    }
    
    if (metadata.boundingBox) {
        const bb = metadata.boundingBox;
        console.log(`${LOG_PREFIX} BoundingBox:`);
        console.log(`${LOG_PREFIX}   Min: (${bb.min.join(', ')})`);
        console.log(`${LOG_PREFIX}   Max: (${bb.max.join(', ')})`);
    }
    
    if (metadata.attributes) {
        console.log(`${LOG_PREFIX} Attributes: ${metadata.attributes.map(a => a.name).join(', ')}`);
    }
    
    console.log(`${LOG_PREFIX} ===========================`);
}

/**
 * Validate cloud.js metadata structure
 */
function validateMetadata(metadata) {
    const errors = [];
    const warnings = [];

    if (!metadata.version) {
        warnings.push('Missing version in metadata');
    }

    if (!metadata.octreeDir) {
        warnings.push('Missing octreeDir in metadata');
    }

    if (!metadata.boundingBox) {
        errors.push('Missing boundingBox in metadata');
    } else {
        const bb = metadata.boundingBox;
        if (bb.lx === undefined || bb.ly === undefined || bb.lz === undefined ||
            bb.ux === undefined || bb.uy === undefined || bb.uz === undefined) {
            errors.push('Invalid boundingBox structure');
        }
    }

    if (!metadata.pointAttributes || !Array.isArray(metadata.pointAttributes)) {
        errors.push('Missing or invalid pointAttributes');
    } else if (metadata.pointAttributes.length === 0) {
        errors.push('pointAttributes array is empty');
    } else if (!metadata.pointAttributes.includes('POSITION_CARTESIAN')) {
        warnings.push('POSITION_CARTESIAN not found in pointAttributes');
    }

    if (metadata.spacing === undefined) {
        warnings.push('Missing spacing in metadata');
    }

    if (metadata.scale === undefined) {
        warnings.push('Missing scale in metadata');
    }

    if (metadata.hierarchyStepSize === undefined) {
        warnings.push('Missing hierarchyStepSize in metadata');
    }

    return { errors, warnings };
}

/**
 * Log metadata information
 */
function logMetadata(metadata) {
    console.log(`${LOG_PREFIX} === POTREE METADATA ===`);
    console.log(`${LOG_PREFIX} Version: ${metadata.version || 'N/A'}`);
    console.log(`${LOG_PREFIX} OctreeDir: ${metadata.octreeDir || 'N/A'}`);
    console.log(`${LOG_PREFIX} Points: ${metadata.points?.toLocaleString() || 'N/A'}`);
    console.log(`${LOG_PREFIX} PointAttributes:`, metadata.pointAttributes || 'N/A');
    console.log(`${LOG_PREFIX} Spacing: ${metadata.spacing || 'N/A'}`);
    console.log(`${LOG_PREFIX} Scale: ${metadata.scale || 'N/A'}`);
    console.log(`${LOG_PREFIX} HierarchyStepSize: ${metadata.hierarchyStepSize || 'N/A'}`);
    
    if (metadata.boundingBox) {
        const bb = metadata.boundingBox;
        console.log(`${LOG_PREFIX} BoundingBox:`);
        console.log(`${LOG_PREFIX}   Min: (${bb.lx}, ${bb.ly}, ${bb.lz})`);
        console.log(`${LOG_PREFIX}   Max: (${bb.ux}, ${bb.uy}, ${bb.uz})`);
        
        const sizeX = bb.ux - bb.lx;
        const sizeY = bb.uy - bb.ly;
        const sizeZ = bb.uz - bb.lz;
        console.log(`${LOG_PREFIX}   Size: (${sizeX.toFixed(2)}, ${sizeY.toFixed(2)}, ${sizeZ.toFixed(2)})`);
    }
    
    console.log(`${LOG_PREFIX} =======================`);
}

/**
 * Find files with specific extension recursively
 */
async function findFilesRecursive(dir, extension) {
    const files = [];
    
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                const subFiles = await findFilesRecursive(fullPath, extension);
                files.push(...subFiles);
            } else if (entry.name.endsWith(extension)) {
                files.push(fullPath);
            }
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Error reading directory ${dir}:`, error.message);
    }
    
    return files;
}

/**
 * Calculate total size of Potree output
 */
async function calculateOutputSize(outputDir) {
    let totalSize = 0;
    let fileCount = 0;
    
    async function walkDir(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                await walkDir(fullPath);
            } else {
                const stat = await fs.stat(fullPath);
                totalSize += stat.size;
                fileCount++;
            }
        }
    }
    
    try {
        await walkDir(outputDir);
    } catch (error) {
        console.warn(`${LOG_PREFIX} Error calculating size:`, error.message);
    }
    
    return {
        totalBytes: totalSize,
        totalMB: (totalSize / (1024 * 1024)).toFixed(2),
        fileCount
    };
}

/**
 * Estimate point count from metadata and file sizes
 */
async function estimatePointCount(outputDir, metadata) {
    if (metadata && metadata.points) {
        return {
            source: 'metadata',
            count: metadata.points
        };
    }

    const dataDir = path.join(outputDir, 'data');
    const binFiles = await findFilesRecursive(dataDir, '.bin');
    
    let totalBinSize = 0;
    for (const binFile of binFiles) {
        const stat = await fs.stat(binFile);
        totalBinSize += stat.size;
    }

    const pointByteSize = calculatePointByteSize(metadata?.pointAttributes || ['POSITION_CARTESIAN']);
    const estimatedPoints = Math.floor(totalBinSize / pointByteSize);
    
    return {
        source: 'estimated',
        count: estimatedPoints,
        totalBinSize,
        pointByteSize
    };
}

/**
 * Calculate bytes per point based on attributes
 */
function calculatePointByteSize(pointAttributes) {
    const ATTRIBUTE_SIZES = {
        'POSITION_CARTESIAN': 12,
        'COLOR_PACKED': 4,
        'RGBA': 4,
        'RGB': 3,
        'INTENSITY': 2,
        'CLASSIFICATION': 1,
        'RETURN_NUMBER': 1,
        'NUMBER_OF_RETURNS': 1,
        'SOURCE_ID': 2,
        'GPS_TIME': 8,
        'NORMAL_SPHEREMAPPED': 2,
        'NORMAL_OCT16': 2,
        'NORMAL': 12
    };
    
    let size = 0;
    for (const attr of pointAttributes) {
        size += ATTRIBUTE_SIZES[attr] || 4;
    }
    return size;
}

module.exports = {
    validatePotreeOutput,
    validateMetadata,
    logMetadata,
    calculateOutputSize,
    estimatePointCount,
    calculatePointByteSize
};
