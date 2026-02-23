$(async function () {
    try {
        const viewer = await initViewer(document.getElementById('viewer'));
        await initOverlay(viewer);
    } catch (err) {
        console.error('Failed to initialize application:', err);
        alert('Failed to initialize application. See console for details.');
    }
});

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
        loadPointCloud(viewer, $pointcloudUrl.val());
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
        const scale = new THREE.Vector3(1, 1, 1);
        
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
