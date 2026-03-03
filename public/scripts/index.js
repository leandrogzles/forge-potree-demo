// ============================================================================
// CAMERA SYNC MODULE
// Handles bidirectional camera synchronization between Forge and Potree
// ============================================================================
const CameraSync = {
    // References
    forgeViewer: null,
    potreeIframe: null,
    
    // State flags to prevent infinite loops
    isSyncingFromPotree: false,
    isSyncingFromForge: false,
    
    // Sync control
    syncEnabled: true,
    
    // Throttle configuration (ms)
    throttleInterval: 33, // ~30fps
    lastForgeSyncTime: 0,
    lastPotreeSyncTime: 0,
    
    // Delta threshold - don't sync if change is smaller than this
    positionDelta: 0.001,
    
    // Last known camera states for delta comparison
    lastForgeCamera: null,
    lastPotreeCamera: null,
    
    /**
     * Initialize the camera sync module
     * @param {Autodesk.Viewing.GuiViewer3D} forgeViewer - The Forge viewer instance
     * @param {HTMLIFrameElement} potreeIframe - The Potree iframe element
     */
    init(forgeViewer, potreeIframe) {
        this.forgeViewer = forgeViewer;
        this.potreeIframe = potreeIframe;
        
        // Listen for Forge camera changes
        this.forgeViewer.addEventListener(
            Autodesk.Viewing.CAMERA_CHANGE_EVENT,
            this.onForgeCameraChange.bind(this)
        );
        
        // Listen for messages from Potree iframe
        window.addEventListener('message', this.onPotreeMessage.bind(this));
        
        console.log('[CameraSync] Initialized');
    },
    
    /**
     * Enable/disable camera synchronization
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.syncEnabled = enabled;
        console.log('[CameraSync] Sync enabled:', enabled);
    },
    
    /**
     * Check if position has changed significantly (beyond delta threshold)
     * @param {Object} pos1 - First position {x, y, z}
     * @param {Object} pos2 - Second position {x, y, z}
     * @returns {boolean} True if positions differ significantly
     */
    hasPositionChanged(pos1, pos2) {
        if (!pos1 || !pos2) return true;
        
        const dx = Math.abs(pos1.x - pos2.x);
        const dy = Math.abs(pos1.y - pos2.y);
        const dz = Math.abs(pos1.z - pos2.z);
        
        return dx > this.positionDelta || 
               dy > this.positionDelta || 
               dz > this.positionDelta;
    },
    
    /**
     * Handle Forge Viewer camera change event
     * Sends camera state to Potree iframe
     */
    onForgeCameraChange() {
        // Skip if sync is disabled or we're currently syncing from Potree
        if (!this.syncEnabled || this.isSyncingFromPotree) {
            return;
        }
        
        // Skip if overlay is not active
        if (!PotreeOverlay.isActive) {
            return;
        }
        
        // Throttle: check if enough time has passed since last sync
        const now = performance.now();
        if (now - this.lastForgeSyncTime < this.throttleInterval) {
            return;
        }
        
        // Get current Forge camera state
        const nav = this.forgeViewer.navigation;
        const position = nav.getPosition();
        const target = nav.getTarget();
        const up = nav.getCameraUpVector();
        const fov = nav.getVerticalFov();
        
        // Check if camera has actually changed (delta comparison)
        const currentCamera = {
            position: { x: position.x, y: position.y, z: position.z },
            target: { x: target.x, y: target.y, z: target.z }
        };
        
        if (this.lastForgeCamera && 
            !this.hasPositionChanged(currentCamera.position, this.lastForgeCamera.position) &&
            !this.hasPositionChanged(currentCamera.target, this.lastForgeCamera.target)) {
            return;
        }
        
        // Update last known state
        this.lastForgeCamera = currentCamera;
        this.lastForgeSyncTime = now;
        
        // Build camera update payload
        const payload = {
            type: 'camera:update',
            source: 'forge',
            position: { x: position.x, y: position.y, z: position.z },
            target: { x: target.x, y: target.y, z: target.z },
            up: { x: up.x, y: up.y, z: up.z },
            fov: fov
        };
        
        // Send to Potree iframe
        this.sendToPotree(payload);
    },
    
    /**
     * Handle messages from Potree iframe
     * @param {MessageEvent} event
     */
    onPotreeMessage(event) {
        // Validate message structure
        if (!event.data || event.data.type !== 'camera:update' || event.data.source !== 'potree') {
            return;
        }
        
        // Skip if sync is disabled or we're currently syncing from Forge
        if (!this.syncEnabled || this.isSyncingFromForge) {
            return;
        }
        
        // Throttle: check if enough time has passed since last sync
        const now = performance.now();
        if (now - this.lastPotreeSyncTime < this.throttleInterval) {
            return;
        }
        
        const { position, target, up, fov } = event.data;
        
        // Check if camera has actually changed (delta comparison)
        const currentCamera = { position, target };
        
        if (this.lastPotreeCamera && 
            !this.hasPositionChanged(currentCamera.position, this.lastPotreeCamera.position) &&
            !this.hasPositionChanged(currentCamera.target, this.lastPotreeCamera.target)) {
            return;
        }
        
        // Update last known state
        this.lastPotreeCamera = currentCamera;
        this.lastPotreeSyncTime = now;
        
        // Set flag to prevent loop
        this.isSyncingFromPotree = true;
        
        // Apply camera state to Forge Viewer
        this.applyToForge(position, target, up, fov);
        
        // Reset flag after next frame to allow future updates
        requestAnimationFrame(() => {
            this.isSyncingFromPotree = false;
        });
    },
    
    /**
     * Send camera update to Potree iframe
     * @param {Object} payload - Camera update payload
     */
    sendToPotree(payload) {
        if (this.potreeIframe && this.potreeIframe.contentWindow) {
            // Set flag to prevent loop
            this.isSyncingFromForge = true;
            
            this.potreeIframe.contentWindow.postMessage(payload, '*');
            
            // Reset flag after next frame
            requestAnimationFrame(() => {
                this.isSyncingFromForge = false;
            });
        }
    },
    
    /**
     * Apply camera state from Potree to Forge Viewer
     * @param {Object} position - Camera position {x, y, z}
     * @param {Object} target - Camera target {x, y, z}
     * @param {Object} up - Camera up vector {x, y, z}
     * @param {number} fov - Field of view in degrees
     */
    applyToForge(position, target, up, fov) {
        if (!this.forgeViewer) return;
        
        const nav = this.forgeViewer.navigation;
        
        // Convert to THREE.Vector3 for Forge API
        const posVec = new THREE.Vector3(position.x, position.y, position.z);
        const targetVec = new THREE.Vector3(target.x, target.y, target.z);
        const upVec = new THREE.Vector3(up.x, up.y, up.z);
        
        // Apply camera position and target
        nav.setView(posVec, targetVec);
        
        // Apply up vector
        nav.setCameraUpVector(upVec);
        
        // Apply FOV if provided
        if (fov !== undefined && fov > 0) {
            nav.setVerticalFov(fov, true);
        }
    },
    
    /**
     * Force sync current Forge camera to Potree
     * Useful for initial alignment
     */
    forceSyncForgeToPortree() {
        const wasEnabled = this.syncEnabled;
        const wasSyncing = this.isSyncingFromPotree;
        
        this.syncEnabled = true;
        this.isSyncingFromPotree = false;
        this.lastForgeSyncTime = 0; // Reset throttle
        this.lastForgeCamera = null; // Reset delta check
        
        this.onForgeCameraChange();
        
        this.syncEnabled = wasEnabled;
        this.isSyncingFromPotree = wasSyncing;
    }
};

// ============================================================================
// POTREE OVERLAY CONTROLLER
// Manages the Potree iframe overlay and UI controls
// ============================================================================
const PotreeOverlay = {
    iframe: null,
    overlay: null,
    isActive: false,
    isInteractive: false,
    opacity: 100,
    pointSize: 0.02,
    cloudUrl: null,
    isLoaded: false,
    
    init() {
        this.iframe = document.getElementById('potree-iframe');
        this.overlay = document.getElementById('potree-overlay');
        
        // Listen for messages from iframe
        window.addEventListener('message', (event) => this.handleMessage(event));
        
        // Setup controls
        this.setupControls();
        
        console.log('[PotreeOverlay] Initialized');
    },
    
    setupControls() {
        // Toggle ON/OFF
        const toggleBtn = document.getElementById('potree-toggle');
        toggleBtn.addEventListener('click', () => this.toggle());
        
        // Opacity slider
        const opacitySlider = document.getElementById('potree-opacity');
        const opacityValue = document.getElementById('potree-opacity-value');
        opacitySlider.addEventListener('input', (e) => {
            this.opacity = parseInt(e.target.value);
            opacityValue.textContent = this.opacity + '%';
            this.updateOpacity();
        });
        
        // Interact toggle
        const interactBtn = document.getElementById('potree-interact');
        interactBtn.addEventListener('click', () => this.toggleInteraction());
        
        // Point size slider
        const pointSizeSlider = document.getElementById('potree-point-size');
        const pointSizeValue = document.getElementById('potree-point-size-value');
        pointSizeSlider.addEventListener('input', (e) => {
            this.pointSize = parseInt(e.target.value) / 1000;
            pointSizeValue.textContent = this.pointSize.toFixed(3);
            this.sendMessage('setPointSize', { size: this.pointSize });
        });
        
        // Camera sync toggle (if it exists)
        const syncBtn = document.getElementById('camera-sync-toggle');
        if (syncBtn) {
            syncBtn.addEventListener('click', () => this.toggleCameraSync());
        }
    },
    
    toggle() {
        this.isActive = !this.isActive;
        const toggleBtn = document.getElementById('potree-toggle');
        const interactBtn = document.getElementById('potree-interact');
        
        if (this.isActive) {
            this.overlay.classList.add('active');
            toggleBtn.classList.add('active');
            toggleBtn.querySelector('.toggle-text').textContent = 'ON';
            interactBtn.disabled = false;
            
            // Load iframe if not already loaded
            if (!this.isLoaded && this.cloudUrl) {
                this.loadCloud(this.cloudUrl);
            } else if (!this.iframe.src) {
                // Initialize iframe without cloud
                this.iframe.src = '/potree.html';
            }
            
            // Force sync camera to Potree after a short delay (wait for iframe to be ready)
            setTimeout(() => {
                if (CameraSync.forgeViewer) {
                    CameraSync.forceSyncForgeToPortree();
                }
            }, 500);
        } else {
            this.overlay.classList.remove('active');
            this.overlay.classList.remove('interactive');
            toggleBtn.classList.remove('active');
            toggleBtn.querySelector('.toggle-text').textContent = 'OFF';
            interactBtn.disabled = true;
            interactBtn.classList.remove('active');
            interactBtn.querySelector('.interact-text').textContent = 'Desativado';
            this.isInteractive = false;
        }
        
        console.log('[PotreeOverlay] Toggled:', this.isActive);
    },
    
    toggleInteraction() {
        if (!this.isActive) return;
        
        this.isInteractive = !this.isInteractive;
        const interactBtn = document.getElementById('potree-interact');
        
        if (this.isInteractive) {
            this.overlay.classList.add('interactive');
            interactBtn.classList.add('active');
            interactBtn.querySelector('.interact-text').textContent = 'Ativado';
        } else {
            this.overlay.classList.remove('interactive');
            interactBtn.classList.remove('active');
            interactBtn.querySelector('.interact-text').textContent = 'Desativado';
        }
        
        console.log('[PotreeOverlay] Interactive:', this.isInteractive);
    },
    
    toggleCameraSync() {
        const syncBtn = document.getElementById('camera-sync-toggle');
        if (!syncBtn) return;
        
        CameraSync.syncEnabled = !CameraSync.syncEnabled;
        
        if (CameraSync.syncEnabled) {
            syncBtn.classList.add('active');
            syncBtn.querySelector('.sync-text').textContent = 'Ativado';
            // Force sync current camera state
            CameraSync.forceSyncForgeToPortree();
        } else {
            syncBtn.classList.remove('active');
            syncBtn.querySelector('.sync-text').textContent = 'Desativado';
        }
        
        console.log('[PotreeOverlay] Camera sync:', CameraSync.syncEnabled);
    },
    
    updateOpacity() {
        if (this.iframe) {
            this.iframe.style.opacity = this.opacity / 100;
        }
    },
    
    loadCloud(url) {
        this.cloudUrl = url;
        
        if (!this.isActive) {
            console.log('[PotreeOverlay] Cloud URL set, will load when activated:', url);
            return;
        }
        
        // Load iframe with cloud URL
        const encodedUrl = encodeURIComponent(url);
        this.iframe.src = `/potree.html?cloud=${encodedUrl}`;
        
        console.log('[PotreeOverlay] Loading cloud:', url);
    },
    
    unloadCloud() {
        this.sendMessage('unload', {});
        this.isLoaded = false;
        this.cloudUrl = null;
    },
    
    sendMessage(action, params) {
        if (this.iframe && this.iframe.contentWindow) {
            this.iframe.contentWindow.postMessage({
                target: 'potree-overlay',
                action: action,
                params: params
            }, '*');
        }
    },
    
    handleMessage(event) {
        if (!event.data || event.data.source !== 'potree-overlay') return;
        
        const { type, data } = event.data;
        
        switch (type) {
            case 'ready':
                console.log('[PotreeOverlay] Iframe ready');
                // Sync camera when Potree is ready
                if (CameraSync.forgeViewer && this.isActive) {
                    setTimeout(() => CameraSync.forceSyncForgeToPortree(), 100);
                }
                break;
                
            case 'pointcloud-loaded':
                console.log('[PotreeOverlay] Point cloud loaded:', data);
                this.isLoaded = true;
                // Sync camera after point cloud is loaded
                if (CameraSync.forgeViewer) {
                    setTimeout(() => CameraSync.forceSyncForgeToPortree(), 100);
                }
                break;
                
            case 'pointcloud-error':
                console.error('[PotreeOverlay] Point cloud error:', data.error);
                alert('Erro ao carregar nuvem de pontos no overlay: ' + data.error);
                break;
                
            case 'pointcloud-unloaded':
                console.log('[PotreeOverlay] Point cloud unloaded');
                this.isLoaded = false;
                break;
                
            case 'camera':
                // Legacy camera message (for backwards compatibility)
                console.log('[PotreeOverlay] Camera state:', data);
                break;
        }
    },
    
    // Legacy methods for backwards compatibility
    setCamera(position, target) {
        this.sendMessage('setCamera', { position, target });
    },
    
    getCamera() {
        this.sendMessage('getCamera', {});
    }
};

$(async function () {
    try {
        // Initialize Potree Overlay controller
        PotreeOverlay.init();
        
        // Initialize Forge Viewer in the new container
        const viewerContainer = document.getElementById('forge-container') || document.getElementById('viewer');
        const viewer = await initViewer(viewerContainer);
        
        // Initialize Camera Sync module
        const potreeIframe = document.getElementById('potree-iframe');
        CameraSync.init(viewer, potreeIframe);
        
        // Initialize LAS Uploader
        LASUploader.init(viewer);
        
        await initOverlay(viewer);
        
        // Check system health on load
        checkSystemHealth();
    } catch (err) {
        console.error('Failed to initialize application:', err);
        alert('Failed to initialize application. See console for details.');
    }
});

// Check system health (PotreeConverter availability)
async function checkSystemHealth() {
    try {
        const response = await fetch('/api/las/health');
        const health = await response.json();
        
        console.log('[System Health]', health);
        
        if (!health.converterAvailable) {
            console.warn('[System Health] PotreeConverter not available - LAS upload will fail');
        }
    } catch (error) {
        console.error('[System Health] Failed to check:', error);
    }
}

// Fetches access token from the server
async function getAccessToken() {
    try {
        const resp = await fetch('/api/auth/token');
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        const { access_token, expires_in } = await resp.json();
        return { access_token, expires_in };
    } catch (err) {
        console.error('Could not obtain access token:', err);
        throw err;
    }
}

// Initializes the viewer
function initViewer(container) {
    return new Promise(function (resolve, reject) {
        const options = {
            env: 'AutodeskProduction',
            getAccessToken: async function (callback) {
                try {
                    const { access_token, expires_in } = await getAccessToken();
                    callback(access_token, expires_in);
                } catch (err) {
                    alert('Could not obtain access token. See the console for more details.');
                    console.error(err);
                    reject(err);
                }
            }
        };
        
        Autodesk.Viewing.Initializer(options, () => {
            const config = {
                extensions: ['PotreeExtension']
            };
            const viewer = new Autodesk.Viewing.GuiViewer3D(container, config);
            viewer.start(null, null, null, null, {
                webglInitParams: {
                    useWebGL2: false
                }
            });
            viewer.setTheme('light-theme');
            viewer.setBackgroundColor(255, 255, 255, 255, 255, 255);
            viewer.setLightPreset(0);
            resolve(viewer);
        });
    });
}

// Initializes the overlay UI
async function initOverlay(viewer) {
    const $overlay = $('#overlay');
    $overlay.append(`
        <div class="loading">
            <div class="spinner-border" class="mx-auto" role="status">
                <span class="sr-only">Loading...</span>
            </div>
        </div>
    `);

    // Setup the model dropdown
    console.log('Getting models...');
    try {
        const models = await getModels();
        console.log(`Found ${models.length} models`);
        $('#overlay > .loading').remove();
        
        const $models = $('#models');
        $models.empty();
        $models.append('<option value="">-- Select a model --</option>');
        
        for (const model of models) {
            $models.append(`<option value="${model.urn}">${model.name}</option>`);
        }
        
        $models.on('change', async function () {
            const urn = $models.val();
            if (urn) {
                await loadModel(viewer, urn);
            }
        });
    } catch (err) {
        console.error('Failed to load models:', err);
        $('#overlay > .loading').remove();
        alert('Could not list models. See the console for more details.');
    }

    // Setup the point cloud input
    const $pointcloudUrl = $('#pointcloud-url');
    const $pointcloudBtn = $('#pointcloud-btn');
    $pointcloudUrl.val(window.location.origin + '/scripts/potree/data/lion_takanawa/cloud.js');
    $pointcloudBtn.on('click', function () {
        const url = $pointcloudUrl.val();
        
        // Load in Forge Viewer (via PotreeExtension)
        loadPointCloud(viewer, url);
        
        // Also set the URL for Potree Overlay (loads when overlay is activated)
        PotreeOverlay.loadCloud(url);
    });
}

// Loads list of viewable models from the server
async function getModels() {
    const resp = await fetch('/api/data/models');
    if (!resp.ok) {
        throw new Error(await resp.text());
    }
    const models = await resp.json();
    return models;
}

// Loads a model into the viewer (returns a Promise)
function loadModel(viewer, urn) {
    console.log('Loading model:', urn);
    return new Promise(function (resolve, reject) {
        function onDocumentLoadSuccess(doc) {
            const viewable = doc.getRoot().getDefaultGeometry();
            if (!viewable) {
                reject(new Error('No viewable geometry found in the document.'));
                return;
            }
            viewer.loadDocumentNode(doc, viewable)
                .then(model => {
                    console.log('Model loaded successfully');
                    viewer.fitToView();
                    resolve(model);
                })
                .catch(err => {
                    console.error('Failed to load document node:', err);
                    reject(err);
                });
        }

        function onDocumentLoadFailure(code, message, errors) {
            const errorMsg = `Could not load document (code: ${code}, message: ${message})`;
            console.error(errorMsg, errors);
            reject(new Error(errorMsg));
        }

        if (!urn) {
            reject(new Error('No URN provided'));
            return;
        }

        viewer.setLightPreset(0);
        Autodesk.Viewing.Document.load('urn:' + urn, onDocumentLoadSuccess, onDocumentLoadFailure);
    });
}

// Loads point cloud model
async function loadPointCloud(viewer, url) {
    const potreeExtension = viewer.getExtension('PotreeExtension');
    if (!potreeExtension) {
        alert('PotreeExtension not available');
        return;
    }
    
    try {
        console.log('Loading point cloud from:', url);
        const fileName = url.split('/').pop();
        console.log('fileName:', fileName);
        const name = `Pointcloud: ${fileName}`;
        const position = new THREE.Vector3(0, 0, 0);
        const scale = new THREE.Vector3(10, 10, 10);
        
        const pointcloud = await potreeExtension.loadPointCloud(name, url, position, scale);
        
        if (pointcloud && pointcloud.boundingBox) {
            console.log('pointcloud.boundingBox');
            const bbox = pointcloud.boundingBox.clone().expandByVector(scale);
            viewer.navigation.fitBounds(false, bbox);
            console.log('Point cloud loaded successfully:', name);
        }
        else{
            console.log('pointcloud.boundingBox not found');
        }
    } catch (err) {
        console.error('Failed to load point cloud:', err);
        alert('Failed to load point cloud. See console for details.');
    }
}

// ============================================================================
// LAS UPLOAD MODULE
// Handles LAS/LAZ file upload and conversion to Potree format
// ============================================================================
const LASUploader = {
    viewer: null,
    selectedFile: null,
    lastResultUrl: null,
    lastDatasetId: null,
    
    init(viewer) {
        this.viewer = viewer;
        this.setupFileInput();
        this.setupUploadButton();
        this.setupResultButton();
        this.setupDatasetsSection();
        this.loadDatasets();
        
        console.log('[LASUploader] Initialized');
    },
    
    setupFileInput() {
        const fileInput = document.getElementById('las-file-input');
        const fileNameDisplay = document.getElementById('las-file-name');
        const uploadBtn = document.getElementById('las-upload-btn');
        
        fileNameDisplay.addEventListener('click', () => fileInput.click());
        
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.selectedFile = e.target.files[0];
                fileNameDisplay.textContent = this.selectedFile.name;
                fileNameDisplay.classList.remove('text-muted');
                uploadBtn.disabled = false;
                
                this.hideResult();
                this.hideError();
                
                console.log('[LASUploader] File selected:', {
                    name: this.selectedFile.name,
                    size: `${(this.selectedFile.size / 1024 / 1024).toFixed(2)} MB`,
                    type: this.selectedFile.type
                });
            } else {
                this.selectedFile = null;
                fileNameDisplay.textContent = 'Clique para selecionar...';
                fileNameDisplay.classList.add('text-muted');
                uploadBtn.disabled = true;
            }
        });
    },
    
    setupUploadButton() {
        const uploadBtn = document.getElementById('las-upload-btn');
        
        uploadBtn.addEventListener('click', async () => {
            if (!this.selectedFile) {
                alert('Selecione um arquivo LAS/LAZ primeiro');
                return;
            }
            
            await this.uploadFile(this.selectedFile);
        });
    },
    
    setupResultButton() {
        const loadResultBtn = document.getElementById('las-load-result-btn');
        
        loadResultBtn.addEventListener('click', () => {
            if (this.lastResultUrl) {
                this.loadPointCloudResult(this.lastResultUrl);
            }
        });
    },
    
    setupDatasetsSection() {
        const refreshBtn = document.getElementById('refresh-datasets-btn');
        const datasetsSelect = document.getElementById('datasets-select');
        const loadBtn = document.getElementById('load-dataset-btn');
        const deleteBtn = document.getElementById('delete-dataset-btn');
        
        refreshBtn.addEventListener('click', () => this.loadDatasets());
        
        datasetsSelect.addEventListener('change', () => {
            const selected = datasetsSelect.value;
            loadBtn.disabled = !selected;
            deleteBtn.disabled = !selected;
        });
        
        loadBtn.addEventListener('click', () => {
            const selected = datasetsSelect.value;
            if (selected) {
                const option = datasetsSelect.options[datasetsSelect.selectedIndex];
                const cloudJsUrl = option.dataset.cloudJsUrl;
                if (cloudJsUrl) {
                    this.loadPointCloudResult(cloudJsUrl);
                }
            }
        });
        
        deleteBtn.addEventListener('click', async () => {
            const selected = datasetsSelect.value;
            if (selected && confirm(`Excluir dataset ${selected}?`)) {
                await this.deleteDataset(selected);
            }
        });
    },
    
    async uploadFile(file) {
        console.log('[LASUploader] Starting upload:', file.name);
        
        this.showProgress();
        this.hideResult();
        this.hideError();
        this.updateProgress(0, 'Enviando arquivo...');
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const xhr = new XMLHttpRequest();
            
            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 50);
                    this.updateProgress(percent, 'Enviando arquivo...');
                }
            });
            
            const response = await new Promise((resolve, reject) => {
                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        try {
                            const errorData = JSON.parse(xhr.responseText);
                            reject(new Error(errorData.error || `HTTP ${xhr.status}`));
                        } catch (e) {
                            reject(new Error(`HTTP ${xhr.status}`));
                        }
                    }
                };
                
                xhr.onerror = () => reject(new Error('Network error'));
                xhr.ontimeout = () => reject(new Error('Request timeout'));
                
                xhr.open('POST', '/api/las/upload');
                xhr.timeout = 30 * 60 * 1000;
                xhr.send(formData);
                
                this.updateProgress(50, 'Convertendo para Potree...');
                
                this.pollConversionStatus(xhr);
            });
            
            if (response.success) {
                this.handleUploadSuccess(response);
            } else {
                throw new Error(response.error || 'Upload failed');
            }
            
        } catch (error) {
            console.error('[LASUploader] Upload failed:', error);
            this.handleUploadError(error.message);
        }
    },
    
    pollConversionStatus(xhr) {
        let progress = 50;
        const interval = setInterval(() => {
            if (xhr.readyState === 4) {
                clearInterval(interval);
                return;
            }
            
            progress = Math.min(95, progress + Math.random() * 5);
            this.updateProgress(progress, 'Convertendo para Potree...');
        }, 1000);
    },
    
    handleUploadSuccess(response) {
        console.log('[LASUploader] Upload successful:', response);
        
        const formatLabel = response.potreeFormat === '2.0' ? 'Potree 2.0' : 'Potree 1.x';
        this.updateProgress(100, `Conversão concluída! (${formatLabel})`);
        
        this.lastResultUrl = response.cloudJsUrl;
        this.lastDatasetId = response.datasetId;
        this.lastPotreeFormat = response.potreeFormat;
        
        setTimeout(() => {
            this.hideProgress();
            this.showResult(response);
            this.loadDatasets();
        }, 500);
    },
    
    handleUploadError(message) {
        console.error('[LASUploader] Error:', message);
        
        this.hideProgress();
        this.showError(message);
    },
    
    showProgress() {
        document.getElementById('las-upload-progress').style.display = 'block';
        document.getElementById('las-upload-btn').disabled = true;
    },
    
    hideProgress() {
        document.getElementById('las-upload-progress').style.display = 'none';
        document.getElementById('las-upload-btn').disabled = false;
    },
    
    updateProgress(percent, statusText) {
        const bar = document.getElementById('las-progress-bar');
        const text = document.getElementById('las-progress-text');
        const status = document.getElementById('las-status-text');
        
        bar.style.width = percent + '%';
        text.textContent = Math.round(percent) + '%';
        status.textContent = statusText;
    },
    
    showResult(response) {
        const resultDiv = document.getElementById('las-upload-result');
        const pointsSpan = document.getElementById('las-result-points');
        
        const points = response.metadata?.points || 'N/A';
        const formatLabel = response.potreeFormat === '2.0' ? ' (Potree 2.0)' : '';
        pointsSpan.textContent = (typeof points === 'number' ? points.toLocaleString() : points) + formatLabel;
        
        resultDiv.style.display = 'block';
    },
    
    hideResult() {
        document.getElementById('las-upload-result').style.display = 'none';
    },
    
    showError(message) {
        const errorDiv = document.getElementById('las-upload-error');
        const errorText = document.getElementById('las-error-text');
        
        errorText.textContent = message;
        errorDiv.style.display = 'block';
    },
    
    hideError() {
        document.getElementById('las-upload-error').style.display = 'none';
    },
    
    async loadDatasets() {
        console.log('[LASUploader] Loading datasets...');
        
        try {
            const response = await fetch('/api/las/datasets');
            const datasets = await response.json();
            
            const select = document.getElementById('datasets-select');
            select.innerHTML = '<option value="">-- Selecione um dataset --</option>';
            
            for (const dataset of datasets) {
                const option = document.createElement('option');
                option.value = dataset.datasetId;
                const formatLabel = dataset.potreeFormat === '2.0' ? ' [2.0]' : ' [1.x]';
                option.textContent = dataset.datasetId.substring(0, 8) + '...' + formatLabel;
                option.dataset.cloudJsUrl = dataset.cloudJsUrl;
                option.dataset.potreeFormat = dataset.potreeFormat;
                select.appendChild(option);
            }
            
            console.log('[LASUploader] Loaded', datasets.length, 'datasets');
            
        } catch (error) {
            console.error('[LASUploader] Failed to load datasets:', error);
        }
    },
    
    async deleteDataset(datasetId) {
        console.log('[LASUploader] Deleting dataset:', datasetId);
        
        try {
            const response = await fetch(`/api/las/dataset/${datasetId}`, {
                method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
                console.log('[LASUploader] Dataset deleted successfully');
                this.loadDatasets();
            } else {
                alert('Erro ao excluir dataset');
            }
            
        } catch (error) {
            console.error('[LASUploader] Failed to delete dataset:', error);
            alert('Erro ao excluir dataset: ' + error.message);
        }
    },
    
    loadPointCloudResult(cloudJsUrl) {
        console.log('[LASUploader] Loading point cloud result:', cloudJsUrl);
        
        loadPointCloud(this.viewer, cloudJsUrl);
        
        PotreeOverlay.loadCloud(cloudJsUrl);
    }
};
