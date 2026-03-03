/**
 * PotreeExtension
 * 
 * Supports both Potree 1.x (cloud.js) and Potree 2.0 (metadata.json) formats
 */
class PotreeExtension extends Autodesk.Viewing.Extension {
    constructor(viewer, options) {
        super(viewer, options);
        this._group = null;
        this._pointclouds = new Map();
        this._potree2Clouds = new Map();
        this._potree2Loader = null;
        this._timer = null;
        this._overlayName = 'potree-scene';
    }

    load() {
        this._group = new THREE.Group();
        if (!this.viewer.overlays.hasScene(this._overlayName)) {
            this.viewer.overlays.addScene(this._overlayName);
        }
        this.viewer.overlays.addMesh(this._group, this._overlayName);

        if (typeof Potree2Loader !== 'undefined') {
            this._potree2Loader = new Potree2Loader(this);
            console.log('[PotreeExtension] Potree2Loader available');
        }

        this.viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, this.updatePointClouds.bind(this));
        this._timer = setInterval(this.updatePointClouds.bind(this), 500);

        console.log('[PotreeExtension] Loaded (supports Potree 1.x and 2.0)');
        return true;
    }

    unload() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        
        if (this._potree2Loader) {
            for (const name of this._potree2Clouds.keys()) {
                this._potree2Loader.unload(name);
            }
            this._potree2Clouds.clear();
        }
        
        this.viewer.overlays.removeScene(this._overlayName);
        console.log('[PotreeExtension] Unloaded');
        return true;
    }

    /**
     * Detect format from URL (cloud.js = 1.x, metadata.json = 2.0)
     */
    _detectFormat(url) {
        if (url.endsWith('metadata.json')) {
            return '2.0';
        }
        return '1.x';
    }

    /**
     * Adds potree model into the scene and starts streaming its data.
     * Automatically detects Potree 1.x (cloud.js) vs 2.0 (metadata.json) format.
     * 
     * @param {string} name Unique name of the model.
     * @param {string} url URL of the potree model main file (cloud.js or metadata.json).
     * @param {THREE.Vector3} [position] Optional position to apply to the newly loaded pointcloud.
     * @param {THREE.Vector3} [scale] Optional scale to apply to the newly loaded pointcloud.
     * @returns {Promise<Object>} Potree point cloud object.
     */
    async loadPointCloud(name, url, position, scale) {
        if (this._pointclouds.has(name) || this._potree2Clouds.has(name)) {
            return this._pointclouds.get(name) || this._potree2Clouds.get(name);
        }

        const format = this._detectFormat(url);
        console.log(`[PotreeExtension] Loading '${name}' with format ${format} from ${url}`);

        if (format === '2.0') {
            return this._loadPotree2(name, url, position, scale);
        } else {
            return this._loadPotree1(name, url, position, scale);
        }
    }

    /**
     * Load Potree 1.x format (cloud.js)
     */
    _loadPotree1(name, url, position, scale) {
        return new Promise((resolve, reject) => {
            if (typeof Potree === 'undefined' || !Potree.loadPointCloud) {
                reject(new Error('Potree 1.x library not loaded'));
                return;
            }
            
            Potree.loadPointCloud(url, name, (ev) => {
                const { pointcloud } = ev;
                const { material } = pointcloud;
                if (position) {
                    pointcloud.position.copy(position);
                }
                if (scale) {
                    pointcloud.scale.copy(scale);
                }
                material.size = 2;
                material.pointColorType = Potree.PointColorType.RGB;
                material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
                material.shape = Potree.PointShape.CIRCLE;
                this._group.add(pointcloud);
                this._pointclouds.set(name, pointcloud);
                this.updatePointClouds();
                console.log(`[PotreeExtension] Potree 1.x '${name}' loaded`);
                resolve(pointcloud);
            });
        });
    }

    /**
     * Load Potree 2.0 format (metadata.json)
     */
    async _loadPotree2(name, url, position, scale) {
        if (!this._potree2Loader) {
            throw new Error('Potree2Loader not available. Include Potree2Loader.js');
        }

        const options = {};
        if (position) {
            options.position = position;
        }
        if (scale) {
            if (scale instanceof THREE.Vector3) {
                options.scale = scale;
            } else {
                options.scale = scale;
            }
        }

        const cloud = await this._potree2Loader.load(name, url, options);
        this._potree2Clouds.set(name, cloud);
        
        this.updatePointClouds();
        console.log(`[PotreeExtension] Potree 2.0 '${name}' loaded`);
        
        return cloud;
    }

    /**
     * Add a Potree 2.0 node to the scene (called by Potree2Loader)
     */
    addNodeToScene(node) {
        if (node.points) {
            this._group.add(node.points);
            this.viewer.impl.invalidate(true);
        }
    }

    /**
     * Remove a Potree 2.0 node from the scene (called by Potree2Loader)
     */
    removeNodeFromScene(node) {
        if (node.points && node.points.parent) {
            this._group.remove(node.points);
            this.viewer.impl.invalidate(true);
        }
    }

    updatePointClouds() {
        const camera = this.viewer.impl.camera;
        const renderer = this.viewer.impl.glrenderer();
        
        const pointclouds = Array.from(this._pointclouds.values());
        if (pointclouds.length > 0 && typeof Potree !== 'undefined') {
            Potree.updatePointClouds(pointclouds, camera, renderer);
        }
        
        if (this._potree2Loader && this._potree2Clouds.size > 0) {
            const canvas = this.viewer.impl.canvas;
            const screenSize = new THREE.Vector2(canvas.width, canvas.height);
            this._potree2Loader.update(camera, screenSize);
        }
        
        this.viewer.impl.invalidate(true);
    }

    /**
     * Unload a specific point cloud
     */
    unloadPointCloud(name) {
        if (this._pointclouds.has(name)) {
            const pc = this._pointclouds.get(name);
            this._group.remove(pc);
            this._pointclouds.delete(name);
            console.log(`[PotreeExtension] Potree 1.x '${name}' unloaded`);
        }
        
        if (this._potree2Clouds.has(name)) {
            this._potree2Loader.unload(name);
            this._potree2Clouds.delete(name);
            console.log(`[PotreeExtension] Potree 2.0 '${name}' unloaded`);
        }
        
        this.viewer.impl.invalidate(true);
    }

    /**
     * Get list of loaded point cloud names
     */
    getLoadedNames() {
        return [
            ...Array.from(this._pointclouds.keys()),
            ...Array.from(this._potree2Clouds.keys())
        ];
    }

    /**
     * Get stats
     */
    getStats() {
        let stats = {
            potree1Clouds: this._pointclouds.size,
            potree2Clouds: this._potree2Clouds.size
        };
        
        if (this._potree2Loader) {
            const p2Stats = this._potree2Loader.getStats();
            stats = { ...stats, ...p2Stats };
        }
        
        return stats;
    }
}

Autodesk.Viewing.theExtensionManager.registerExtension('PotreeExtension', PotreeExtension);
