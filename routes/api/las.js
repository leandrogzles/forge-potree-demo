/**
 * LAS Upload API Routes
 * 
 * Endpoints:
 *   POST /api/las/upload     - Upload LAS/LAZ file for conversion
 *   GET  /api/las/status/:id - Get conversion status
 *   GET  /api/las/datasets   - List all datasets
 *   GET  /api/las/dataset/:id - Get dataset info
 *   DELETE /api/las/dataset/:id - Delete dataset
 *   GET  /api/las/health     - Check system health
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const lasUploadController = require('../../services/lasUploadController');

const router = express.Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'temp', 'uploads');

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            await fs.mkdir(UPLOAD_DIR, { recursive: true });
            cb(null, UPLOAD_DIR);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `las-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.las' || ext === '.laz') {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type: ${ext}. Only .las and .laz files are allowed.`), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: parseInt(process.env.MAX_LAS_FILE_SIZE) || 2 * 1024 * 1024 * 1024 // 2GB default
    }
});

/**
 * POST /api/las/upload
 * Upload a LAS/LAZ file for conversion to Potree format
 * 
 * Request: multipart/form-data with 'file' field
 * Response: { success, datasetId, cloudJsUrl, metadata }
 */
router.post('/upload', upload.single('file'), async (req, res) => {
    console.log('[LAS API] Upload request received');
    
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

        console.log('[LAS API] File received:', {
            originalname: req.file.originalname,
            size: req.file.size,
            path: req.file.path
        });

        const options = {
            conversionOptions: {
                spacing: req.body.spacing ? parseFloat(req.body.spacing) : undefined,
                maxDepth: req.body.maxDepth ? parseInt(req.body.maxDepth) : undefined,
                outputFormat: req.body.outputFormat || undefined
            }
        };

        const result = await lasUploadController.handleUpload(req.file, options);

        if (result.success) {
            res.json({
                success: true,
                datasetId: result.datasetId,
                cloudJsUrl: result.cloudJsUrl,
                potreeFormat: result.potreeFormat,
                originalName: result.originalName,
                metadata: result.metadata,
                duration: result.duration
            });
        } else {
            res.status(500).json({
                success: false,
                datasetId: result.datasetId,
                error: result.error
            });
        }

    } catch (error) {
        console.error('[LAS API] Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/las/status/:id
 * Get status of an upload/conversion
 * 
 * Response: { datasetId, status, progress, ... }
 */
router.get('/status/:id', (req, res) => {
    const { id } = req.params;
    
    const status = lasUploadController.getUploadStatus(id);
    
    if (status) {
        res.json(status);
    } else {
        res.status(404).json({
            error: 'Dataset not found or conversion completed'
        });
    }
});

/**
 * GET /api/las/datasets
 * List all available datasets
 * 
 * Response: [{ datasetId, cloudJsUrl, type }, ...]
 */
router.get('/datasets', async (req, res) => {
    try {
        const datasets = await lasUploadController.listDatasets();
        res.json(datasets);
    } catch (error) {
        console.error('[LAS API] List datasets error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * GET /api/las/dataset/:id
 * Get info for a specific dataset
 * 
 * Response: { datasetId, cloudJsUrl, path, type }
 */
router.get('/dataset/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const info = await lasUploadController.getDatasetInfo(id);
        
        if (info) {
            res.json(info);
        } else {
            res.status(404).json({
                error: 'Dataset not found'
            });
        }
    } catch (error) {
        console.error('[LAS API] Get dataset error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * DELETE /api/las/dataset/:id
 * Delete a dataset
 * 
 * Response: { success }
 */
router.delete('/dataset/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const success = await lasUploadController.deleteDataset(id);
        res.json({ success });
    } catch (error) {
        console.error('[LAS API] Delete dataset error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

/**
 * GET /api/las/pending
 * Get all pending uploads/conversions
 * 
 * Response: [{ datasetId, status, progress, originalName }, ...]
 */
router.get('/pending', (req, res) => {
    const pending = lasUploadController.getPendingUploads();
    res.json(pending);
});

/**
 * GET /api/las/health
 * Check system health (converter availability, storage status)
 * 
 * Response: { converterAvailable, storageType, pendingUploads, activeConversions }
 */
router.get('/health', async (req, res) => {
    try {
        const health = await lasUploadController.checkHealth();
        res.json(health);
    } catch (error) {
        console.error('[LAS API] Health check error:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                error: 'File too large'
            });
        }
        return res.status(400).json({
            success: false,
            error: error.message
        });
    }
    
    if (error) {
        return res.status(400).json({
            success: false,
            error: error.message
        });
    }
    
    next();
});

module.exports = router;
