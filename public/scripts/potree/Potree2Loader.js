/**
 * Potree2Loader
 * 
 * Loader for Potree 2.0 format (metadata.json + octree.bin + hierarchy.bin)
 * Compatible with PotreeConverter 2.x output
 * 
 * Potree 2.0 format:
 * - metadata.json: Contains point cloud metadata, attributes, bounding box
 * - hierarchy.bin: Contains octree hierarchy structure
 * - octree.bin: Contains all point data in a single file
 * 
 * @version 1.0.0
 */

(function() {
    'use strict';

    const LOG_PREFIX = '[Potree2Loader]';

    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        console.warn(LOG_PREFIX, ...args);
    }

    function error(...args) {
        console.error(LOG_PREFIX, ...args);
    }

    // ========================================================================
    // POTREE 2.0 POINT CLOUD
    // ========================================================================

    class Potree2PointCloud {
        constructor(metadataUrl, metadata) {
            this.metadataUrl = metadataUrl;
            this.baseUrl = metadataUrl.substring(0, metadataUrl.lastIndexOf('/'));
            
            this.version = metadata.version || '2.0';
            this.name = metadata.name || 'pointcloud';
            this.points = metadata.points || 0;
            this.spacing = metadata.spacing || 1.0;
            this.scale = metadata.scale || [0.001, 0.001, 0.001];
            this.offset = metadata.offset || [0, 0, 0];
            this.encoding = metadata.encoding || 'DEFAULT';
            this.hierarchy = metadata.hierarchy || { firstChunkSize: 0, stepSize: 4, depth: 0 };
            this.attributes = metadata.attributes || [];
            
            const bb = metadata.boundingBox || { min: [0, 0, 0], max: [1, 1, 1] };
            this.boundingBox = new THREE.Box3(
                new THREE.Vector3(bb.min[0], bb.min[1], bb.min[2]),
                new THREE.Vector3(bb.max[0], bb.max[1], bb.max[2])
            );
            
            this.pointByteSize = this._calculatePointByteSize();
            
            this.root = null;
            this.hierarchyData = null;
            this.octreeData = null;
            
            this.position = new THREE.Vector3(0, 0, 0);
            this.rotation = new THREE.Euler(0, 0, 0);
            this.scale3 = new THREE.Vector3(1, 1, 1);
            this.matrixWorld = new THREE.Matrix4();
            
            this.visible = true;
            
            log('Potree2PointCloud created:', {
                name: this.name,
                points: this.points,
                spacing: this.spacing,
                attributes: this.attributes.map(a => a.name),
                pointByteSize: this.pointByteSize
            });
        }

        _calculatePointByteSize() {
            let size = 0;
            for (const attr of this.attributes) {
                size += attr.size;
            }
            return size;
        }

        updateMatrixWorld() {
            this.matrixWorld.compose(
                this.position, 
                new THREE.Quaternion().setFromEuler(this.rotation), 
                this.scale3
            );
        }

        getOctreeUrl() {
            return `${this.baseUrl}/octree.bin`;
        }

        getHierarchyUrl() {
            return `${this.baseUrl}/hierarchy.bin`;
        }
    }

    // ========================================================================
    // POTREE 2.0 NODE
    // ========================================================================

    class Potree2Node {
        constructor(name, cloud, parent = null) {
            this.name = name;
            this.cloud = cloud;
            this.parent = parent;
            this.level = name.length - 1;
            this.index = name.length > 1 ? parseInt(name.charAt(name.length - 1), 10) : -1;
            
            this.children = new Array(8).fill(null);
            this.hasChildren = false;
            
            this.boundingBox = this._computeBoundingBox();
            this.boundingSphere = new THREE.Sphere();
            this.boundingBox.getBoundingSphere(this.boundingSphere);
            
            this.numPoints = 0;
            this.byteOffset = 0;
            this.byteSize = 0;
            
            this.loaded = false;
            this.loading = false;
            this.failed = false;
            
            this.geometry = null;
            this.material = null;
            this.points = null;
            
            this.visible = false;
            this.distance = Infinity;
            this.screenSize = 0;
        }

        _computeBoundingBox() {
            const rootMin = this.cloud.boundingBox.min.clone();
            const rootMax = this.cloud.boundingBox.max.clone();
            
            let min = rootMin.clone();
            let max = rootMax.clone();
            
            for (let i = 1; i < this.name.length; i++) {
                const childIndex = parseInt(this.name.charAt(i), 10);
                const midX = (min.x + max.x) / 2;
                const midY = (min.y + max.y) / 2;
                const midZ = (min.z + max.z) / 2;
                
                if (childIndex & 1) { min.x = midX; } else { max.x = midX; }
                if (childIndex & 2) { min.y = midY; } else { max.y = midY; }
                if (childIndex & 4) { min.z = midZ; } else { max.z = midZ; }
            }
            
            return new THREE.Box3(min, max);
        }

        getChildName(childIndex) {
            return this.name + childIndex;
        }

        addChild(childIndex, child) {
            this.children[childIndex] = child;
            this.hasChildren = true;
        }

        dispose() {
            if (this.geometry) {
                this.geometry.dispose();
                this.geometry = null;
            }
            if (this.material) {
                this.material.dispose();
                this.material = null;
            }
            this.points = null;
            this.loaded = false;
        }
    }

    // ========================================================================
    // POTREE 2.0 HIERARCHY PARSER
    // ========================================================================

    class Potree2HierarchyParser {
        constructor(cloud) {
            this.cloud = cloud;
        }

        parse(hierarchyBuffer) {
            const view = new DataView(hierarchyBuffer);
            const bytesPerNode = 22;
            const numNodes = hierarchyBuffer.byteLength / bytesPerNode;
            
            log(`Parsing hierarchy: ${numNodes} nodes, ${hierarchyBuffer.byteLength} bytes`);
            
            const nodes = new Map();
            const root = new Potree2Node('r', this.cloud);
            nodes.set('r', root);
            
            const stack = [{ node: root, offset: 0 }];
            let nodesProcessed = 0;
            
            let currentOffset = 0;
            
            while (stack.length > 0 && currentOffset < hierarchyBuffer.byteLength) {
                const { node } = stack.shift();
                
                const type = view.getUint8(currentOffset);
                const childMask = view.getUint8(currentOffset + 1);
                const numPoints = view.getUint32(currentOffset + 2, true);
                const byteOffset = Number(view.getBigInt64(currentOffset + 6, true));
                const byteSize = Number(view.getBigInt64(currentOffset + 14, true));
                
                currentOffset += bytesPerNode;
                nodesProcessed++;
                
                node.numPoints = numPoints;
                node.byteOffset = byteOffset;
                node.byteSize = byteSize;
                
                for (let i = 0; i < 8; i++) {
                    if (childMask & (1 << i)) {
                        const childName = node.getChildName(i);
                        const child = new Potree2Node(childName, this.cloud, node);
                        node.addChild(i, child);
                        nodes.set(childName, child);
                        stack.push({ node: child, offset: currentOffset });
                    }
                }
            }
            
            log(`Hierarchy parsed: ${nodesProcessed} nodes processed`);
            
            return { root, nodes };
        }
    }

    // ========================================================================
    // POTREE 2.0 NODE LOADER
    // ========================================================================

    class Potree2NodeLoader {
        constructor(cloud, octreeBuffer) {
            this.cloud = cloud;
            this.octreeBuffer = octreeBuffer;
            this.loading = new Map();
        }

        async loadNode(node) {
            if (node.loaded || node.loading) {
                return this.loading.get(node.name);
            }

            node.loading = true;
            
            const promise = (async () => {
                try {
                    if (node.byteSize === 0 || node.numPoints === 0) {
                        node.loaded = true;
                        node.loading = false;
                        return;
                    }
                    
                    const buffer = this.octreeBuffer.slice(
                        node.byteOffset,
                        node.byteOffset + node.byteSize
                    );
                    
                    this._decodeBuffer(node, buffer);
                    
                    node.loaded = true;
                    node.loading = false;
                    
                } catch (err) {
                    warn(`Failed to load node ${node.name}:`, err.message);
                    node.failed = true;
                    node.loading = false;
                }
                
                this.loading.delete(node.name);
            })();
            
            this.loading.set(node.name, promise);
            return promise;
        }

        _decodeBuffer(node, buffer) {
            const numPoints = node.numPoints;
            const pointByteSize = this.cloud.pointByteSize;
            
            if (numPoints === 0) return;
            
            const positions = new Float32Array(numPoints * 3);
            const colors = new Float32Array(numPoints * 3);
            
            const view = new DataView(buffer);
            const scale = this.cloud.scale;
            const offset = this.cloud.offset;
            
            let hasColors = false;
            let minPos = new THREE.Vector3(Infinity, Infinity, Infinity);
            let maxPos = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
            
            let positionAttrOffset = 0;
            let rgbAttrOffset = -1;
            
            let attrOffset = 0;
            for (const attr of this.cloud.attributes) {
                if (attr.name === 'position') {
                    positionAttrOffset = attrOffset;
                } else if (attr.name === 'rgb') {
                    rgbAttrOffset = attrOffset;
                }
                attrOffset += attr.size;
            }
            
            for (let i = 0; i < numPoints; i++) {
                const pointOffset = i * pointByteSize;
                
                const ix = view.getInt32(pointOffset + positionAttrOffset, true);
                const iy = view.getInt32(pointOffset + positionAttrOffset + 4, true);
                const iz = view.getInt32(pointOffset + positionAttrOffset + 8, true);
                
                const x = ix * scale[0] + offset[0];
                const y = iy * scale[1] + offset[1];
                const z = iz * scale[2] + offset[2];
                
                positions[i * 3] = x;
                positions[i * 3 + 1] = y;
                positions[i * 3 + 2] = z;
                
                minPos.x = Math.min(minPos.x, x);
                minPos.y = Math.min(minPos.y, y);
                minPos.z = Math.min(minPos.z, z);
                maxPos.x = Math.max(maxPos.x, x);
                maxPos.y = Math.max(maxPos.y, y);
                maxPos.z = Math.max(maxPos.z, z);
                
                if (rgbAttrOffset >= 0) {
                    const r = view.getUint16(pointOffset + rgbAttrOffset, true) / 65535.0;
                    const g = view.getUint16(pointOffset + rgbAttrOffset + 2, true) / 65535.0;
                    const b = view.getUint16(pointOffset + rgbAttrOffset + 4, true) / 65535.0;
                    
                    colors[i * 3] = r;
                    colors[i * 3 + 1] = g;
                    colors[i * 3 + 2] = b;
                    hasColors = true;
                }
            }
            
            if (!hasColors) {
                const range = maxPos.z - minPos.z || 1;
                for (let i = 0; i < numPoints; i++) {
                    const z = positions[i * 3 + 2];
                    const t = (z - minPos.z) / range;
                    const hue = t * 0.7;
                    const rgb = this._hslToRgb(hue, 0.8, 0.5);
                    colors[i * 3] = rgb[0];
                    colors[i * 3 + 1] = rgb[1];
                    colors[i * 3 + 2] = rgb[2];
                }
            }
            
            node.geometry = new THREE.BufferGeometry();
            node.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            node.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            node.geometry.boundingBox = new THREE.Box3(minPos, maxPos);
            node.geometry.boundingSphere = new THREE.Sphere();
            node.geometry.boundingBox.getBoundingSphere(node.geometry.boundingSphere);
            
            const PointsMaterialClass = THREE.PointsMaterial || THREE.PointCloudMaterial;
            node.material = new PointsMaterialClass({
                size: 2,
                sizeAttenuation: false,
                vertexColors: true
            });
            
            const PointsClass = THREE.Points || THREE.PointCloud;
            node.points = new PointsClass(node.geometry, node.material);
            node.points.name = `Potree2Node_${node.name}`;
            node.points.frustumCulled = false;
            node.points.matrixAutoUpdate = false;
            node.points.matrix.copy(this.cloud.matrixWorld);
            node.points.matrixWorld.copy(this.cloud.matrixWorld);
        }

        _hslToRgb(h, s, l) {
            let r, g, b;
            if (s === 0) {
                r = g = b = l;
            } else {
                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1;
                    if (t > 1) t -= 1;
                    if (t < 1/6) return p + (q - p) * 6 * t;
                    if (t < 1/2) return q;
                    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                    return p;
                };
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r = hue2rgb(p, q, h + 1/3);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1/3);
            }
            return [r, g, b];
        }
    }

    // ========================================================================
    // POTREE 2.0 SCHEDULER
    // ========================================================================

    class Potree2Scheduler {
        constructor(cloud, extension, octreeBuffer) {
            this.cloud = cloud;
            this.extension = extension;
            this.nodeLoader = new Potree2NodeLoader(cloud, octreeBuffer);
            
            this.visibleNodes = new Set();
            this.loadingNodes = new Set();
            this.renderedPoints = 0;
            
            this.frustum = new THREE.Frustum();
            this.projScreenMatrix = new THREE.Matrix4();
            
            this.lastUpdateTime = 0;
            this.updateInterval = 100;
            this.pointBudget = 3000000;
            this.maxConcurrentLoads = 4;
            this.minNodePixelSize = 100;
        }

        async update(camera, screenSize) {
            const now = performance.now();
            if (now - this.lastUpdateTime < this.updateInterval) {
                return;
            }
            this.lastUpdateTime = now;
            
            if (!this.cloud.visible || !this.cloud.root) {
                return;
            }
            
            this.projScreenMatrix.multiplyMatrices(
                camera.projectionMatrix,
                camera.matrixWorldInverse
            );
            this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
            
            const candidates = [];
            this._collectCandidates(this.cloud.root, camera, screenSize, candidates);
            
            candidates.sort((a, b) => b.priority - a.priority);
            
            const selectedNodes = new Set();
            let totalPoints = 0;
            
            for (const candidate of candidates) {
                if (totalPoints + candidate.node.numPoints > this.pointBudget) {
                    break;
                }
                selectedNodes.add(candidate.node);
                totalPoints += candidate.node.numPoints;
            }
            
            const nodesToLoad = [];
            for (const node of selectedNodes) {
                if (!node.loaded && !node.loading && !node.failed && node.numPoints > 0) {
                    nodesToLoad.push(node);
                }
            }
            
            const currentLoading = this.loadingNodes.size;
            const canLoad = Math.max(0, this.maxConcurrentLoads - currentLoading);
            
            for (let i = 0; i < Math.min(nodesToLoad.length, canLoad); i++) {
                const node = nodesToLoad[i];
                this.loadingNodes.add(node);
                
                this.nodeLoader.loadNode(node).then(() => {
                    this.loadingNodes.delete(node);
                    
                    if (node.loaded && node.points) {
                        this.extension.addNodeToScene(node);
                    }
                });
            }
            
            this._updateVisibility(selectedNodes);
            this.renderedPoints = totalPoints;
        }

        _collectCandidates(node, camera, screenSize, candidates) {
            if (!node) return;
            
            const worldBox = node.boundingBox.clone();
            worldBox.applyMatrix4(this.cloud.matrixWorld);
            
            if (!this.frustum.intersectsBox(worldBox)) {
                return;
            }
            
            const center = new THREE.Vector3();
            worldBox.getCenter(center);
            const distance = camera.position.distanceTo(center);
            
            const boxSize = new THREE.Vector3();
            worldBox.getSize(boxSize);
            const radius = boxSize.length() / 2;
            
            const fov = camera.fov * Math.PI / 180;
            const slope = Math.tan(fov / 2);
            const projectedSize = (radius / (slope * distance)) * screenSize.y;
            
            node.distance = distance;
            node.screenSize = projectedSize;
            
            const priority = projectedSize / (node.level + 1);
            
            if (projectedSize > this.minNodePixelSize || node.level === 0) {
                candidates.push({
                    node: node,
                    priority: priority,
                    distance: distance,
                    screenSize: projectedSize
                });
            }
            
            if (projectedSize > this.minNodePixelSize * 2 || node.level < 2) {
                for (const child of node.children) {
                    if (child) {
                        this._collectCandidates(child, camera, screenSize, candidates);
                    }
                }
            }
        }

        _updateVisibility(selectedNodes) {
            for (const node of this.visibleNodes) {
                if (!selectedNodes.has(node)) {
                    this.extension.removeNodeFromScene(node);
                }
            }
            
            for (const node of selectedNodes) {
                if (node.loaded && node.points && !this.visibleNodes.has(node)) {
                    this.extension.addNodeToScene(node);
                }
            }
            
            this.visibleNodes.clear();
            for (const node of selectedNodes) {
                if (node.loaded && node.points) {
                    this.visibleNodes.add(node);
                }
            }
        }

        dispose() {
            for (const node of this.visibleNodes) {
                this.extension.removeNodeFromScene(node);
                node.dispose();
            }
            this.visibleNodes.clear();
            this.loadingNodes.clear();
            this._disposeNodeTree(this.cloud.root);
        }

        _disposeNodeTree(node) {
            if (!node) return;
            
            if (node.points) {
                this.extension.removeNodeFromScene(node);
                node.dispose();
            }
            
            for (const child of node.children) {
                if (child) {
                    this._disposeNodeTree(child);
                }
            }
        }
    }

    // ========================================================================
    // POTREE 2.0 LOADER (Main entry point)
    // ========================================================================

    class Potree2Loader {
        constructor(extension) {
            this.extension = extension;
            this.clouds = new Map();
            this.schedulers = new Map();
        }

        async load(name, metadataUrl, options = {}) {
            if (this.clouds.has(name)) {
                log(`Cloud '${name}' already loaded`);
                return this.clouds.get(name);
            }

            log(`Loading Potree 2.0 point cloud '${name}' from ${metadataUrl}`);

            try {
                const metadataResponse = await fetch(metadataUrl);
                if (!metadataResponse.ok) {
                    throw new Error(`Failed to fetch metadata: HTTP ${metadataResponse.status}`);
                }
                const metadata = await metadataResponse.json();
                
                const cloud = new Potree2PointCloud(metadataUrl, metadata);
                
                if (options.position) {
                    cloud.position.copy(options.position);
                }
                if (options.rotation) {
                    cloud.rotation.copy(options.rotation);
                }
                if (options.scale) {
                    if (typeof options.scale === 'number') {
                        cloud.scale3.set(options.scale, options.scale, options.scale);
                    } else {
                        cloud.scale3.copy(options.scale);
                    }
                }
                cloud.updateMatrixWorld();
                
                log('Loading hierarchy.bin...');
                const hierarchyResponse = await fetch(cloud.getHierarchyUrl());
                if (!hierarchyResponse.ok) {
                    throw new Error(`Failed to fetch hierarchy: HTTP ${hierarchyResponse.status}`);
                }
                const hierarchyBuffer = await hierarchyResponse.arrayBuffer();
                
                const hierarchyParser = new Potree2HierarchyParser(cloud);
                const { root, nodes } = hierarchyParser.parse(hierarchyBuffer);
                cloud.root = root;
                cloud.nodes = nodes;
                
                log('Loading octree.bin...');
                const octreeResponse = await fetch(cloud.getOctreeUrl());
                if (!octreeResponse.ok) {
                    throw new Error(`Failed to fetch octree: HTTP ${octreeResponse.status}`);
                }
                const octreeBuffer = await octreeResponse.arrayBuffer();
                cloud.octreeData = octreeBuffer;
                
                const scheduler = new Potree2Scheduler(cloud, this.extension, octreeBuffer);
                
                await scheduler.nodeLoader.loadNode(cloud.root);
                
                if (cloud.root.loaded && cloud.root.points) {
                    this.extension.addNodeToScene(cloud.root);
                }
                
                this.clouds.set(name, cloud);
                this.schedulers.set(name, scheduler);
                
                log(`Potree 2.0 point cloud '${name}' loaded successfully`);
                log(`  - Total points: ${cloud.points.toLocaleString()}`);
                log(`  - Root points: ${cloud.root.numPoints.toLocaleString()}`);
                log(`  - Bounding box:`, cloud.boundingBox);
                
                return cloud;
                
            } catch (err) {
                error(`Failed to load Potree 2.0 point cloud '${name}':`, err);
                throw err;
            }
        }

        unload(name) {
            const scheduler = this.schedulers.get(name);
            if (scheduler) {
                scheduler.dispose();
                this.schedulers.delete(name);
            }
            this.clouds.delete(name);
            log(`Point cloud '${name}' unloaded`);
        }

        update(camera, screenSize) {
            for (const scheduler of this.schedulers.values()) {
                scheduler.update(camera, screenSize);
            }
        }

        getCloud(name) {
            return this.clouds.get(name);
        }

        getScheduler(name) {
            return this.schedulers.get(name);
        }

        getStats() {
            let totalPoints = 0;
            let totalNodes = 0;
            
            for (const scheduler of this.schedulers.values()) {
                totalPoints += scheduler.renderedPoints;
                totalNodes += scheduler.visibleNodes.size;
            }
            
            return {
                totalPoints,
                totalNodes,
                cloudsLoaded: this.clouds.size
            };
        }
    }

    window.Potree2Loader = Potree2Loader;
    window.Potree2PointCloud = Potree2PointCloud;
    window.Potree2Node = Potree2Node;
    window.Potree2Scheduler = Potree2Scheduler;

    log('Potree2Loader registered');

})();
