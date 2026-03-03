# LAS/LAZ Upload to Potree Pipeline

This document describes the LAS to Potree conversion pipeline integrated into the Forge/APS Viewer.

## Overview

The pipeline allows users to:
1. Upload `.las` or `.laz` point cloud files
2. Automatically convert them to Potree format using PotreeConverter
3. Load the converted point cloud in the Forge Viewer using the custom runtime

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Browser)                        │
├─────────────────────────────────────────────────────────────────┤
│  index.html           │  index.js (LASUploader)                 │
│  - File selector      │  - handleUpload()                       │
│  - Progress bar       │  - loadPointCloudResult()               │
│  - Dataset list       │  - pollConversionStatus()               │
└────────────┬──────────┴──────────────────────────────────────────┘
             │ HTTP POST /api/las/upload
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Backend (Node.js)                         │
├─────────────────────────────────────────────────────────────────┤
│  routes/api/las.js           │  services/                       │
│  - POST /upload              │  ├── lasUploadController.js      │
│  - GET /status/:id           │  ├── potreeConversionService.js  │
│  - GET /datasets             │  ├── datasetStorageService.js    │
│  - DELETE /dataset/:id       │  └── validationUtils.js          │
└────────────┬─────────────────┴──────────────────────────────────┘
             │ child_process.spawn()
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PotreeConverter CLI                         │
├─────────────────────────────────────────────────────────────────┤
│  PotreeConverter input.las -o output_dir                        │
│                                                                  │
│  Output:                                                         │
│    output_dir/                                                   │
│    ├── cloud.js              (metadata)                         │
│    └── data/                                                     │
│        └── r/                                                    │
│            ├── r.hrc         (hierarchy)                        │
│            ├── r.bin         (root points)                      │
│            ├── r0.bin        (child nodes)                      │
│            └── ...                                               │
└─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Storage (Local or S3)                         │
├─────────────────────────────────────────────────────────────────┤
│  Local: public/datasets/{datasetId}/                            │
│  S3:    s3://{bucket}/potree-datasets/{datasetId}/              │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### PotreeConverter Installation

The backend requires PotreeConverter to be installed and accessible.

**Windows:**
1. Download from: https://github.com/potree/PotreeConverter/releases
2. Extract and add to system PATH, or set `POTREE_CONVERTER_PATH` environment variable

**Linux/Mac:**
```bash
# Build from source
git clone https://github.com/potree/PotreeConverter.git
cd PotreeConverter
mkdir build && cd build
cmake ..
make
sudo make install
```

### Environment Variables

Create a `.env` file with the following optional variables:

```env
# PotreeConverter path (default: assumes in PATH)
POTREE_CONVERTER_PATH=C:/path/to/PotreeConverter.exe

# Storage configuration
STORAGE_TYPE=local                    # 'local' or 's3'
LOCAL_STORAGE_PATH=./public/datasets  # Local storage directory
TEMP_PATH=./temp                      # Temporary upload directory

# S3 configuration (if STORAGE_TYPE=s3)
S3_BUCKET=my-potree-bucket
S3_REGION=us-east-1
S3_PREFIX=potree-datasets

# Upload limits
MAX_LAS_FILE_SIZE=524288000          # 500MB default
MAX_CONCURRENT_CONVERSIONS=2         # Concurrent conversion limit
```

## API Reference

### POST /api/las/upload

Upload a LAS/LAZ file for conversion.

**Request:**
- Content-Type: `multipart/form-data`
- Body: `file` (required) - The LAS/LAZ file

**Optional form fields:**
- `spacing` - Point spacing for conversion
- `maxDepth` - Maximum octree depth
- `outputFormat` - Output format override

**Response:**
```json
{
  "success": true,
  "datasetId": "uuid",
  "cloudJsUrl": "/datasets/uuid/cloud.js",
  "originalName": "input.las",
  "metadata": {
    "version": "1.7",
    "points": 1234567,
    "pointAttributes": ["POSITION_CARTESIAN", "COLOR_PACKED"],
    "boundingBox": { "lx": 0, "ly": 0, "lz": 0, "ux": 100, "uy": 100, "uz": 50 }
  },
  "duration": 45000
}
```

### GET /api/las/status/:id

Get conversion status.

**Response:**
```json
{
  "datasetId": "uuid",
  "status": "converting",
  "progress": 45,
  "originalName": "input.las"
}
```

### GET /api/las/datasets

List all available datasets.

**Response:**
```json
[
  {
    "datasetId": "uuid1",
    "cloudJsUrl": "/datasets/uuid1/cloud.js",
    "type": "local"
  }
]
```

### GET /api/las/dataset/:id

Get specific dataset info.

### DELETE /api/las/dataset/:id

Delete a dataset.

### GET /api/las/health

Check system health.

**Response:**
```json
{
  "converterAvailable": true,
  "storageType": "local",
  "pendingUploads": 0,
  "activeConversions": 1
}
```

## Frontend Usage

### Automatic Integration

The LAS upload UI is automatically included in `index.html`. Users can:

1. Click the file selector to choose a `.las` or `.laz` file
2. Click "Upload" to start the conversion
3. Watch the progress bar during upload and conversion
4. Click "Carregar no Viewer" to load the result

### Programmatic Usage

```javascript
// Upload a file programmatically
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const response = await fetch('/api/las/upload', {
  method: 'POST',
  body: formData
});

const result = await response.json();

if (result.success) {
  // Load in viewer
  loadPointCloud(viewer, result.cloudJsUrl);
  
  // Also load in Potree overlay
  PotreeOverlay.loadCloud(result.cloudJsUrl);
}
```

## File Structure

```
forge-potree-demo-master/
├── server.js                          # Updated server with LAS routes
├── package.json                       # Updated dependencies
├── config.js                          # Configuration
├── routes/
│   └── api/
│       ├── auth.js                    # Existing auth routes
│       ├── data.js                    # Existing data routes
│       └── las.js                     # NEW: LAS upload routes
├── services/
│   ├── lasUploadController.js         # NEW: Upload orchestration
│   ├── potreeConversionService.js     # NEW: PotreeConverter wrapper
│   ├── datasetStorageService.js       # NEW: Storage management
│   └── validationUtils.js             # NEW: Output validation
├── public/
│   ├── index.html                     # Updated with upload UI
│   ├── datasets/                      # NEW: Converted datasets storage
│   ├── styles/
│   │   └── common.css                 # Updated with upload styles
│   └── scripts/
│       └── index.js                   # Updated with LASUploader module
└── temp/                              # NEW: Temporary upload storage
    └── uploads/
```

## Validation

After conversion, the system validates:

1. **cloud.js existence** - Required metadata file
2. **data/ directory** - Contains octree hierarchy
3. **Metadata structure** - Valid bounding box, point attributes
4. **Binary files** - At least some .bin files present
5. **Hierarchy files** - .hrc files for LOD structure

Validation logs details to console:
```
[ValidationUtils] === POTREE METADATA ===
[ValidationUtils] Version: 1.7
[ValidationUtils] Points: 1,234,567
[ValidationUtils] PointAttributes: ["POSITION_CARTESIAN", "COLOR_PACKED"]
[ValidationUtils] BoundingBox:
[ValidationUtils]   Min: (0.00, 0.00, 0.00)
[ValidationUtils]   Max: (100.00, 100.00, 50.00)
[ValidationUtils] =======================
```

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `PotreeConverter not found` | Converter not in PATH | Set `POTREE_CONVERTER_PATH` |
| `Invalid file type` | Wrong file extension | Use `.las` or `.laz` files |
| `File too large` | Exceeds max size | Increase `MAX_LAS_FILE_SIZE` |
| `Conversion failed` | Invalid LAS file | Check file integrity |
| `Validation failed` | Bad converter output | Check PotreeConverter version |

## Future Improvements

### Conversion Queue
For handling multiple uploads:
- Implement job queue (Bull, Agenda, etc.)
- WebSocket for real-time progress
- Background processing

### S3 Integration
For production deployments:
- Direct upload to S3
- CloudFront distribution
- Pre-signed URLs

### Large Point Clouds (>100M points)
Strategies for very large files:
- Chunked conversion
- Distributed processing
- Progressive loading

## Dependencies

**Required:**
- `express` - Web server
- `multer` - File upload handling
- `uuid` - Unique ID generation

**Optional (for S3):**
- `@aws-sdk/client-s3` - S3 client
- `@aws-sdk/lib-storage` - Multipart upload

## Testing

1. Start the server:
```bash
npm install
npm start
```

2. Check health endpoint:
```bash
curl http://localhost:3000/api/las/health
```

3. Upload a test file:
```bash
curl -X POST -F "file=@test.las" http://localhost:3000/api/las/upload
```

4. Access the viewer:
```
http://localhost:3000/
```
