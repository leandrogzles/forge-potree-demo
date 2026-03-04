/**
 * ForgePotreePointCloudExtension
 * 
 * Renderiza nuvens de pontos Potree DENTRO do Autodesk APS/Forge Viewer
 * usando THREE.Points em overlay scene, com streaming/LOD por nós do octree.
 * 
 * Compatível com Potree 1.7 format (cloud.js + hierarchyStepSize + .hrc/.bin)
 * 
 * @author Generated for BIM + Point Cloud integration
 * @version 1.0.0
 */

(function() {
    'use strict';

    // ========================================================================
    // CONSTANTS & CONFIG
    // ========================================================================
    
    const CONFIG = {
        POINT_BUDGET: 20_000_000,          // Max points to render (high for detailed views)
        MAX_CONCURRENT_LOADS: 24,// 12,          // Concurrent bin fetches (increased)
        MIN_NODE_PIXEL_SIZE: 2,// 5,            // Min screen size for node selection (very low = more detail)
        REFINEMENT_THRESHOLD: 30,          // Screen pixels threshold to refine (low = aggressive refinement)
        CACHE_SIZE: 300,                   // Max cached nodes (increased)
        UPDATE_INTERVAL: 25,               // ms between scheduler updates (faster)
        DEBUG: true,                       // Enable console logs
        DEBUG_LOD: true                    // Enable detailed LOD debug logs (TEMPORARY FOR DEBUG)
    };

    // Point attribute sizes in bytes
    const POINT_ATTRIBUTE_SIZES = {
        'POSITION_CARTESIAN': 12,      // 3 * float32
        'COLOR_PACKED': 4,             // 4 * uint8 (RGBA)
        'RGBA': 4,                     // 4 * uint8
        'RGB': 3,                      // 3 * uint8
        'INTENSITY': 2,                // uint16
        'CLASSIFICATION': 1,           // uint8
        'RETURN_NUMBER': 1,            // uint8
        'NUMBER_OF_RETURNS': 1,        // uint8
        'SOURCE_ID': 2,                // uint16
        'GPS_TIME': 8,                 // float64
        'NORMAL_SPHEREMAPPED': 2,      // 2 * uint8
        'NORMAL_OCT16': 2,             // 2 * uint8
        'NORMAL': 12                   // 3 * float32
    };

    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('[ForgePotree]', ...args);
        }
    }

    function warn(...args) {
        console.warn('[ForgePotree]', ...args);
    }

    function error(...args) {
        console.error('[ForgePotree]', ...args);
    }

    // ========================================================================
    // POTREE CLOUD - Metadata holder
    // ========================================================================

    class PotreeCloud {
        constructor(cloudJsUrl, metadata) {
            this.cloudJsUrl = cloudJsUrl;
            this.baseUrl = cloudJsUrl.substring(0, cloudJsUrl.lastIndexOf('/'));
            
            // Parse metadata
            this.version = metadata.version || '1.7';
            this.octreeDir = metadata.octreeDir || 'data';
            this.spacing = metadata.spacing || 1.0;
            this.scale = metadata.scale || 1.0;
            this.hierarchyStepSize = metadata.hierarchyStepSize || 5;
            this.pointAttributes = metadata.pointAttributes || ['POSITION_CARTESIAN'];
            
            // Bounding box
            const bb = metadata.boundingBox || {};
            this.boundingBox = {
                min: new THREE.Vector3(bb.lx || 0, bb.ly || 0, bb.lz || 0),
                max: new THREE.Vector3(bb.ux || 1, bb.uy || 1, bb.uz || 1)
            };
            
            // Tight bounding box
            const tbb = metadata.tightBoundingBox || bb;
            this.tightBoundingBox = {
                min: new THREE.Vector3(tbb.lx || bb.lx || 0, tbb.ly || bb.ly || 0, tbb.lz || bb.lz || 0),
                max: new THREE.Vector3(tbb.ux || bb.ux || 1, tbb.uy || bb.uy || 1, tbb.uz || bb.uz || 1)
            };
            
            // Calculate stride (bytes per point)
            this.pointByteSize = this._calculatePointByteSize();
            
            // Root node
            this.root = null;
            
            // Transform
            this.position = new THREE.Vector3(0, 0, 0);
            this.rotation = new THREE.Euler(0, 0, 0);
            this.scale3 = new THREE.Vector3(1, 1, 1);
            this.matrixWorld = new THREE.Matrix4();
            this.matrixWorldInverse = new THREE.Matrix4();
            
            // Visibility
            this.visible = true;
            
            log('PotreeCloud created:', {
                baseUrl: this.baseUrl,
                octreeDir: this.octreeDir,
                pointAttributes: this.pointAttributes,
                pointByteSize: this.pointByteSize,
                boundingBox: this.boundingBox
            });
        }

        _calculatePointByteSize() {
            let size = 0;
            for (const attr of this.pointAttributes) {
                const attrSize = POINT_ATTRIBUTE_SIZES[attr];
                if (attrSize === undefined) {
                    warn(`Unknown point attribute: ${attr}, assuming 4 bytes`);
                    size += 4;
                } else {
                    size += attrSize;
                }
            }
            return size;
        }

        updateMatrixWorld() {
            this.matrixWorld.compose(this.position, new THREE.Quaternion().setFromEuler(this.rotation), this.scale3);
            this.matrixWorldInverse.copy(this.matrixWorld).invert();
        }

        getBinUrl(nodeName) {
            // Potree 1.7 structure options:
            // 1. Flat: baseUrl/octreeDir/r/nodeName.bin
            // 2. Nested: baseUrl/octreeDir/r/0/1/2/r012.bin (hierarchyStepSize based)
            // We'll try flat first, the loader will handle fallback
            return `${this.baseUrl}/${this.octreeDir}/r/${nodeName}.bin`;
        }

        getHrcUrl(nodeName) {
            // Potree 1.7 structure: baseUrl/octreeDir/r/nodeName.hrc
            return `${this.baseUrl}/${this.octreeDir}/r/${nodeName}.hrc`;
        }

        getNestedBinUrl(nodeName) {
            // Nested structure for deeper nodes
            // r012 -> r/0/1/r012.bin (based on hierarchyStepSize)
            const path = this._getNestedPath(nodeName);
            return `${this.baseUrl}/${this.octreeDir}/${path}/${nodeName}.bin`;
        }

        _getNestedPath(nodeName) {
            // Build nested path based on node name
            // 'r' -> 'r'
            // 'r0' -> 'r/0'
            // 'r01' -> 'r/0/1'
            if (nodeName === 'r') return 'r';
            
            let path = 'r';
            for (let i = 1; i < nodeName.length; i++) {
                path += '/' + nodeName.charAt(i);
            }
            return path;
        }
    }

    // ========================================================================
    // POTREE NODE - Octree node structure
    // ========================================================================

    class PotreeNode {
        constructor(name, cloud, parent = null) {
            this.name = name;
            this.cloud = cloud;
            this.parent = parent;
            this.level = name.length - 1; // 'r' = level 0, 'r0' = level 1, etc.
            this.index = name.length > 1 ? parseInt(name.charAt(name.length - 1), 10) : -1;
            
            // Children (8 for octree)
            this.children = new Array(8).fill(null);
            this.hasChildren = false;
            
            // Bounding box (calculated based on name)
            this.boundingBox = this._calculateBoundingBox();
            this.boundingSphere = new THREE.Sphere();
            this.boundingBox.getBoundingSphere(this.boundingSphere);
            
            // Point data
            this.numPoints = 0;
            this.spacing = cloud.spacing / Math.pow(2, this.level);
            
            // Loading state
            this.loaded = false;
            this.loading = false;
            this.failed = false;
            
            // THREE.js objects
            this.geometry = null;
            this.material = null;
            this.points = null;
            
            // Hierarchy
            this.hierarchyLoaded = false;
            
            // Selection state
            this.visible = false;
            this.distance = Infinity;
            this.screenSize = 0;
            
            // LOD state tracking
            this.isInScene = false;
            this.shouldRefine = false;
            this.lastVisibleTime = 0;
        }

        _calculateBoundingBox() {
            const rootMin = this.cloud.boundingBox.min.clone();
            const rootMax = this.cloud.boundingBox.max.clone();
            const size = new THREE.Vector3().subVectors(rootMax, rootMin);
            
            let min = rootMin.clone();
            let max = rootMax.clone();
            
            // Navigate through the name to calculate bbox
            // 'r' is root, then each digit 0-7 subdivides the octree
            for (let i = 1; i < this.name.length; i++) {
                const childIndex = parseInt(this.name.charAt(i), 10);
                const halfSize = size.clone().divideScalar(Math.pow(2, i));
                
                // Octree child indexing:
                // 0: ---  1: +--  2: -+-  3: ++-
                // 4: --+  5: +-+  6: -++  7: +++
                const offsetX = (childIndex & 1) ? halfSize.x : 0;
                const offsetY = (childIndex & 2) ? halfSize.y : 0;
                const offsetZ = (childIndex & 4) ? halfSize.z : 0;
                
                min = new THREE.Vector3(
                    rootMin.x + offsetX + (i > 1 ? this._getAccumulatedOffset(i - 1, 0) : 0),
                    rootMin.y + offsetY + (i > 1 ? this._getAccumulatedOffset(i - 1, 1) : 0),
                    rootMin.z + offsetZ + (i > 1 ? this._getAccumulatedOffset(i - 1, 2) : 0)
                );
            }
            
            // Recalculate properly using recursive subdivision
            return this._computeBBoxFromName();
        }

        _computeBBoxFromName() {
            const rootMin = this.cloud.boundingBox.min.clone();
            const rootMax = this.cloud.boundingBox.max.clone();
            
            let min = rootMin.clone();
            let max = rootMax.clone();
            
            for (let i = 1; i < this.name.length; i++) {
                const childIndex = parseInt(this.name.charAt(i), 10);
                const midX = (min.x + max.x) / 2;
                const midY = (min.y + max.y) / 2;
                const midZ = (min.z + max.z) / 2;
                
                // X axis
                if (childIndex & 1) {
                    min.x = midX;
                } else {
                    max.x = midX;
                }
                
                // Y axis
                if (childIndex & 2) {
                    min.y = midY;
                } else {
                    max.y = midY;
                }
                
                // Z axis
                if (childIndex & 4) {
                    min.z = midZ;
                } else {
                    max.z = midZ;
                }
            }
            
            return new THREE.Box3(min, max);
        }

        _getAccumulatedOffset(depth, axis) {
            let offset = 0;
            const rootMin = this.cloud.boundingBox.min;
            const rootMax = this.cloud.boundingBox.max;
            const size = new THREE.Vector3().subVectors(rootMax, rootMin);
            
            for (let i = 1; i <= depth; i++) {
                const childIndex = parseInt(this.name.charAt(i), 10);
                const halfSize = size.clone().divideScalar(Math.pow(2, i));
                
                const bit = axis === 0 ? 1 : (axis === 1 ? 2 : 4);
                if (childIndex & bit) {
                    offset += halfSize.getComponent(axis);
                }
            }
            
            return offset;
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
    // POTREE HIERARCHY LOADER - Loads .hrc files
    // ========================================================================

    class PotreeHierarchyLoader {
        constructor(cloud) {
            this.cloud = cloud;
            this.loadedHrcFiles = new Set();
        }

        async loadHierarchy(node) {
            if (node.hierarchyLoaded) {
                return;
            }

            // Determine which .hrc file to load based on hierarchyStepSize
            const hrcLevel = Math.floor(node.level / this.cloud.hierarchyStepSize) * this.cloud.hierarchyStepSize;
            const hrcNodeName = node.name.substring(0, hrcLevel + 1) || 'r';
            
            // Don't reload the same .hrc file
            if (this.loadedHrcFiles.has(hrcNodeName)) {
                node.hierarchyLoaded = true;
                return;
            }
            
            const url = this.cloud.getHrcUrl(hrcNodeName);
            
            try {
                log(`Loading hierarchy: ${url}`);
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const buffer = await response.arrayBuffer();
                
                // Find the base node for this hierarchy file
                let baseNode = this.cloud.root;
                if (hrcNodeName !== 'r') {
                    baseNode = this._findNode(hrcNodeName);
                }
                
                if (baseNode) {
                    this._parseHierarchy(baseNode, buffer, hrcNodeName);
                }
                
                this.loadedHrcFiles.add(hrcNodeName);
                
            } catch (err) {
                warn(`Failed to load hierarchy ${url}:`, err.message);
                // Mark as loaded to prevent retry
                node.hierarchyLoaded = true;
            }
        }

        _findNode(nodeName) {
            let current = this.cloud.root;
            
            for (let i = 1; i < nodeName.length; i++) {
                const childIndex = parseInt(nodeName.charAt(i), 10);
                if (current.children[childIndex]) {
                    current = current.children[childIndex];
                } else {
                    return null;
                }
            }
            
            return current;
        }

        _parseHierarchy(rootNode, buffer, baseName) {
            const view = new DataView(buffer);
            const stack = [rootNode];
            
            let bytesRead = 0;
            const baseLevel = baseName.length - 1;
            
            while (stack.length > 0 && bytesRead < buffer.byteLength) {
                const node = stack.shift();
                
                if (bytesRead + 5 > buffer.byteLength) {
                    break;
                }
                
                // Read hierarchy entry (5 bytes per node)
                // 1 byte: child mask
                // 4 bytes: number of points
                const childMask = view.getUint8(bytesRead);
                const numPoints = view.getUint32(bytesRead + 1, true);
                bytesRead += 5;
                
                node.numPoints = numPoints;
                node.hierarchyLoaded = true;
                
                // Create children based on mask
                for (let i = 0; i < 8; i++) {
                    if (childMask & (1 << i)) {
                        let child = node.children[i];
                        
                        if (!child) {
                            const childName = node.getChildName(i);
                            child = new PotreeNode(childName, this.cloud, node);
                            node.addChild(i, child);
                        }
                        
                        // Only add to stack if within this .hrc file's scope
                        const relativeLevel = child.level - baseLevel;
                        if (relativeLevel < this.cloud.hierarchyStepSize) {
                            stack.push(child);
                        }
                    }
                }
            }
            
            log(`Hierarchy parsed for ${rootNode.name}: ${rootNode.numPoints} points, read ${bytesRead} bytes`);
        }
    }

    // ========================================================================
    // POTREE NODE LOADER - Decodes .bin files
    // ========================================================================

    class PotreeNodeLoader {
        constructor(cloud) {
            this.cloud = cloud;
            this.loading = new Map(); // nodeName -> Promise
        }

        async loadNode(node) {
            if (node.loaded || node.loading) {
                return this.loading.get(node.name);
            }

            node.loading = true;
            
            const promise = (async () => {
                try {
                    log(`Loading node: ${node.name}`);
                    
                    // Try flat structure first
                    let url = this.cloud.getBinUrl(node.name);
                    let response = await fetch(url);
                    
                    // If flat fails, try nested structure
                    if (!response.ok && node.name !== 'r') {
                        url = this.cloud.getNestedBinUrl(node.name);
                        response = await fetch(url);
                    }
                    
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status} for ${url}`);
                    }
                    
                    const buffer = await response.arrayBuffer();
                    
                    if (buffer.byteLength === 0) {
                        throw new Error('Empty buffer');
                    }
                    
                    this._decodeBuffer(node, buffer);
                    
                    node.loaded = true;
                    node.loading = false;
                    
                    log(`Node loaded: ${node.name}, ${node.numPoints} points`);
                    
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
            const pointByteSize = this.cloud.pointByteSize;
            const numPoints = Math.floor(buffer.byteLength / pointByteSize);
            
            if (numPoints === 0) {
                warn(`Node ${node.name} has 0 points (buffer: ${buffer.byteLength} bytes, stride: ${pointByteSize})`);
                return;
            }
            
            node.numPoints = numPoints;
            
            // Allocate arrays
            const positions = new Float32Array(numPoints * 3);
            const colors = new Float32Array(numPoints * 3);
            
            // TODO: Add intensity/classification arrays when implementing colormaps
            // const intensities = new Float32Array(numPoints);
            // const classifications = new Uint8Array(numPoints);
            
            const view = new DataView(buffer);
            const scale = this.cloud.scale;
            const bbMin = this.cloud.boundingBox.min;
            
            let hasColors = false;
            let minPos = new THREE.Vector3(Infinity, Infinity, Infinity);
            let maxPos = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
            
            // Decode based on pointAttributes
            for (let i = 0; i < numPoints; i++) {
                const byteOffset = i * pointByteSize;
                let attrOffset = 0;
                
                for (const attr of this.cloud.pointAttributes) {
                    const offset = byteOffset + attrOffset;
                    
                    switch (attr) {
                        case 'POSITION_CARTESIAN': {
                            // Potree 1.7 stores positions as int32 relative to bounding box min
                            const x = view.getInt32(offset, true) * scale + bbMin.x;
                            const y = view.getInt32(offset + 4, true) * scale + bbMin.y;
                            const z = view.getInt32(offset + 8, true) * scale + bbMin.z;
                            
                            positions[i * 3] = x;
                            positions[i * 3 + 1] = y;
                            positions[i * 3 + 2] = z;
                            
                            // Track bounds
                            minPos.x = Math.min(minPos.x, x);
                            minPos.y = Math.min(minPos.y, y);
                            minPos.z = Math.min(minPos.z, z);
                            maxPos.x = Math.max(maxPos.x, x);
                            maxPos.y = Math.max(maxPos.y, y);
                            maxPos.z = Math.max(maxPos.z, z);
                            
                            attrOffset += 12;
                            break;
                        }
                        
                        case 'COLOR_PACKED':
                        case 'RGBA': {
                            // RGBA packed as 4 bytes
                            colors[i * 3] = view.getUint8(offset) / 255.0;
                            colors[i * 3 + 1] = view.getUint8(offset + 1) / 255.0;
                            colors[i * 3 + 2] = view.getUint8(offset + 2) / 255.0;
                            hasColors = true;
                            attrOffset += 4;
                            break;
                        }
                        
                        case 'RGB': {
                            colors[i * 3] = view.getUint8(offset) / 255.0;
                            colors[i * 3 + 1] = view.getUint8(offset + 1) / 255.0;
                            colors[i * 3 + 2] = view.getUint8(offset + 2) / 255.0;
                            hasColors = true;
                            attrOffset += 3;
                            break;
                        }
                        
                        case 'INTENSITY': {
                            // TODO: Store for colormap
                            // const intensity = view.getUint16(offset, true);
                            // intensities[i] = intensity / 65535.0;
                            attrOffset += 2;
                            break;
                        }
                        
                        case 'CLASSIFICATION': {
                            // TODO: Store for colormap
                            // classifications[i] = view.getUint8(offset);
                            attrOffset += 1;
                            break;
                        }
                        
                        case 'NORMAL_SPHEREMAPPED':
                        case 'NORMAL_OCT16': {
                            attrOffset += 2;
                            break;
                        }
                        
                        case 'NORMAL': {
                            attrOffset += 12;
                            break;
                        }
                        
                        case 'RETURN_NUMBER':
                        case 'NUMBER_OF_RETURNS': {
                            attrOffset += 1;
                            break;
                        }
                        
                        case 'SOURCE_ID': {
                            attrOffset += 2;
                            break;
                        }
                        
                        case 'GPS_TIME': {
                            attrOffset += 8;
                            break;
                        }
                        
                        default: {
                            const size = POINT_ATTRIBUTE_SIZES[attr] || 4;
                            attrOffset += size;
                            break;
                        }
                    }
                }
            }
            
            // Create geometry
            node.geometry = new THREE.BufferGeometry();
            node.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            
            if (hasColors) {
                node.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            } else {
                // Generate height-based colors as fallback
                const heightColors = this._generateHeightColors(positions, minPos, maxPos);
                node.geometry.setAttribute('color', new THREE.BufferAttribute(heightColors, 3));
                hasColors = true;
            }
            
            // Set bounding box directly (we computed it during decode)
            node.geometry.boundingBox = new THREE.Box3(minPos, maxPos);
            node.geometry.boundingSphere = new THREE.Sphere();
            node.geometry.boundingBox.getBoundingSphere(node.geometry.boundingSphere);
            
            // Create material with optimized settings for LOD transitions
            const PointsMaterialClass = THREE.PointsMaterial || THREE.PointCloudMaterial;
            node.material = new PointsMaterialClass({
                size: 5,                    // Larger points to fill gaps when zooming in
                sizeAttenuation: true,      // Points scale with distance (important!)
                vertexColors: true,
                depthWrite: true,           // Allow proper depth sorting
                depthTest: true,
                transparent: false
            });
            
            // Create points object
            // Forge Viewer THREE.js may use PointCloud instead of Points (older THREE.js version)
            const PointsClass = THREE.Points || THREE.PointCloud;
            if (!PointsClass) {
                // Fallback: create a simple mesh with points-like rendering
                warn('Neither THREE.Points nor THREE.PointCloud available, using Line fallback');
                node.points = new THREE.Line(node.geometry, node.material);
            } else {
                node.points = new PointsClass(node.geometry, node.material);
            }
            node.points.name = `PotreeNode_${node.name}`;
            node.points.frustumCulled = false;
            
            // Apply cloud transform
            node.points.matrixAutoUpdate = false;
            node.points.matrix.copy(this.cloud.matrixWorld);
            node.points.matrixWorld.copy(this.cloud.matrixWorld);
        }

        _generateHeightColors(positions, minPos, maxPos) {
            const numPoints = positions.length / 3;
            const colors = new Float32Array(numPoints * 3);
            const range = maxPos.z - minPos.z || 1;
            
            for (let i = 0; i < numPoints; i++) {
                const z = positions[i * 3 + 2];
                const t = (z - minPos.z) / range;
                
                // Rainbow gradient
                const hue = t * 0.7; // Blue to red
                const rgb = this._hslToRgb(hue, 0.8, 0.5);
                
                colors[i * 3] = rgb[0];
                colors[i * 3 + 1] = rgb[1];
                colors[i * 3 + 2] = rgb[2];
            }
            
            return colors;
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
    // POTREE SCHEDULER - Selection and LOD management (FIXED)
    // ========================================================================

    class PotreeScheduler {
        constructor(cloud, extension) {
            this.cloud = cloud;
            this.extension = extension;
            this.hierarchyLoader = new PotreeHierarchyLoader(cloud);
            this.nodeLoader = new PotreeNodeLoader(cloud);
            
            this.visibleNodes = new Set();       // Nodes currently in scene
            this.loadingNodes = new Set();       // Nodes being loaded
            this.selectedNodes = new Set();      // Nodes selected this frame
            this.renderedPoints = 0;
            
            this.frustum = new THREE.Frustum();
            this.projScreenMatrix = new THREE.Matrix4();
            
            this.lastUpdateTime = 0;
            this.frameCount = 0;
            
            // Debug stats
            this._debugStats = {
                selectedCount: 0,
                visibleCount: 0,
                loadingCount: 0,
                totalPoints: 0,
                unloadedCount: 0,
                refinedCount: 0,
                keptParentsCount: 0
            };
        }

        /**
         * Calculate Screen Space Error (projected size in pixels)
         */
        _calculateScreenSpaceError(node, camera, screenSize) {
            const worldBox = node.boundingBox.clone();
            worldBox.applyMatrix4(this.cloud.matrixWorld);
            
            const center = new THREE.Vector3();
            worldBox.getCenter(center);
            
            const boxSize = new THREE.Vector3();
            worldBox.getSize(boxSize);
            const radius = boxSize.length() / 2;
            
            const distance = camera.position.distanceTo(center);
            
            // Prevent division by zero
            if (distance < 0.0000001) {
                return Infinity;
            }
            
            const fov = camera.fov * Math.PI / 180;
            const screenHeight = screenSize.y;
            const projectedSize = (radius / distance) * (screenHeight / (2 * Math.tan(fov / 2)));
            
            return projectedSize;
        }

        /**
         * Check if a node should be refined (load children instead)
         */
        _shouldRefine(node, screenSize) {
            return node.screenSize > CONFIG.REFINEMENT_THRESHOLD && node.hasChildren;
        }

        /**
         * Check if children are loaded enough to hide parent
         */
        _childrenLoadedEnough(node) {
            if (!node.hasChildren) {
                return false;
            }
            
            let loadedChildrenCount = 0;
            let totalChildrenCount = 0;
            
            for (const child of node.children) {
                if (child) {
                    totalChildrenCount++;
                    if (child.loaded && child.points) {
                        loadedChildrenCount++;
                    }
                }
            }
            
            if (totalChildrenCount === 0) {
                return false;
            }
            
            // Require at least one child loaded, or all visible children loaded
            return loadedChildrenCount >= 1;
        }

        /**
         * Check if a node is inside the view frustum
         */
        _isInFrustum(node) {
            const worldBox = node.boundingBox.clone();
            worldBox.applyMatrix4(this.cloud.matrixWorld);
            return this.frustum.intersectsBox(worldBox);
        }

        async update(camera, screenSize) {
            const now = performance.now();
            if (now - this.lastUpdateTime < CONFIG.UPDATE_INTERVAL) {
                return;
            }
            this.lastUpdateTime = now;
            this.frameCount++;
            
            if (!this.cloud.visible || !this.cloud.root) {
                return;
            }
            
            // Reset debug stats
            this._debugStats = {
                selectedCount: 0,
                visibleCount: 0,
                loadingCount: this.loadingNodes.size,
                totalPoints: 0,
                unloadedCount: 0,
                refinedCount: 0,
                keptParentsCount: 0
            };
            
            // Update frustum
            this.projScreenMatrix.multiplyMatrices(
                camera.projectionMatrix,
                camera.matrixWorldInverse
            );
            this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
            
            // Phase 1: Collect all candidate nodes with their screen sizes
            const candidates = [];
            this._collectCandidates(this.cloud.root, camera, screenSize, candidates);
            
            // Phase 2: Sort by priority (higher screen size = higher priority)
            candidates.sort((a, b) => {
                // Primary: screen size (larger is more important)
                if (Math.abs(a.screenSize - b.screenSize) > 10) {
                    return b.screenSize - a.screenSize;
                }
                // Secondary: level (lower level = parent = more important as fallback)
                return a.node.level - b.node.level;
            });
            
            // Phase 3: Select nodes respecting budget AND safe unloading
            const newSelectedNodes = new Set();
            const nodesToHide = new Set();
            let totalPoints = 0;
            
            for (const candidate of candidates) {
                const node = candidate.node;
                
                // Check budget
                if (totalPoints + node.numPoints > CONFIG.POINT_BUDGET) {
                    // If node is currently visible and in frustum, try to keep it
                    if (this.visibleNodes.has(node) && this._isInFrustum(node)) {
                        // Allow slight budget overflow for visible nodes to prevent holes
                        if (totalPoints + node.numPoints < CONFIG.POINT_BUDGET * 1.2) {
                            newSelectedNodes.add(node);
                            totalPoints += node.numPoints;
                            continue;
                        }
                    }
                    continue;
                }
                
                newSelectedNodes.add(node);
                totalPoints += node.numPoints;
            }
            
            this._debugStats.selectedCount = newSelectedNodes.size;
            this._debugStats.totalPoints = totalPoints;
            
            // Phase 4: Safe parent/child visibility management
            // Don't remove parents until children are loaded
            const finalVisibleNodes = new Set();
            
            for (const node of newSelectedNodes) {
                const parent = node.parent;
                
                // Check if this node should be visible
                if (node.loaded && node.points) {
                    finalVisibleNodes.add(node);
                    node.lastVisibleTime = now;
                }
                
                // If we're selecting children, check if parent can be hidden
                if (parent && parent.loaded && parent.points) {
                    const shouldRefineParent = this._shouldRefine(parent, screenSize);
                    
                    if (shouldRefineParent) {
                        if (this._childrenLoadedEnough(parent)) {
                            // Children ready, parent can be hidden
                            this._debugStats.refinedCount++;
                        } else {
                            // Keep parent visible until children load
                            if (!finalVisibleNodes.has(parent)) {
                                finalVisibleNodes.add(parent);
                                this._debugStats.keptParentsCount++;
                            }
                        }
                    }
                }
            }
            
            // Also keep currently visible parents if their children aren't ready
            for (const node of this.visibleNodes) {
                if (!finalVisibleNodes.has(node) && node.loaded && node.points) {
                    // Check if this node is being replaced by children
                    let childrenInSelection = 0;
                    let childrenLoaded = 0;
                    
                    for (const child of node.children) {
                        if (child && newSelectedNodes.has(child)) {
                            childrenInSelection++;
                            if (child.loaded && child.points) {
                                childrenLoaded++;
                            }
                        }
                    }
                    
                    // If children are selected but not all loaded, keep parent
                    if (childrenInSelection > 0 && childrenLoaded < childrenInSelection) {
                        finalVisibleNodes.add(node);
                        this._debugStats.keptParentsCount++;
                    }
                }
            }
            
            // Phase 5: Queue loading for selected but unloaded nodes
            const nodesToLoad = [];
            for (const node of newSelectedNodes) {
                // FIXED: Don't require numPoints > 0 since it might not be set yet from hierarchy
                // numPoints will be determined after loading the .bin file
                if (!node.loaded && !node.loading && !node.failed) {
                    nodesToLoad.push(node);
                }
            }
            
            // Sort by priority (screen size) for loading order
            nodesToLoad.sort((a, b) => b.screenSize - a.screenSize);
            
            // Limit concurrent loads
            const currentLoading = this.loadingNodes.size;
            const canLoad = Math.max(0, CONFIG.MAX_CONCURRENT_LOADS - currentLoading);
            
            for (let i = 0; i < Math.min(nodesToLoad.length, canLoad); i++) {
                const node = nodesToLoad[i];
                this.loadingNodes.add(node);
                
                this.nodeLoader.loadNode(node).then(() => {
                    this.loadingNodes.delete(node);
                    
                    if (node.loaded && node.points) {
                        // Add to scene immediately when loaded
                        this._addNodeToScene(node);
                    }
                });
            }
            
            // Phase 6: Update scene visibility
            this._updateSceneVisibility(finalVisibleNodes);
            
            // Store selected nodes for next frame
            this.selectedNodes = newSelectedNodes;
            this._debugStats.visibleCount = this.visibleNodes.size;
            this.renderedPoints = this._calculateActualRenderedPoints();
            
            // Debug logging - more frequent for debugging
            if (CONFIG.DEBUG_LOD && this.frameCount % 30 === 0) {
                this._logDebugStats();
            }
        }

        _collectCandidates(node, camera, screenSize, candidates) {
            if (!node) return;
            
            // Load hierarchy if needed (this is synchronous after first load)
            if (!node.hierarchyLoaded) {
                this.hierarchyLoader.loadHierarchy(node);
            }
            
            // Frustum culling
            if (!this._isInFrustum(node)) {
                return;
            }
            
            // Calculate screen space error
            const projectedSize = this._calculateScreenSpaceError(node, camera, screenSize);
            
            node.screenSize = projectedSize;
            
            // FIXED: Check if node has children OR if hierarchy might have more children
            // The hierarchy file indicates if a node CAN have children via childMask
            const canHaveChildren = node.hasChildren || !node.hierarchyLoaded;
            node.shouldRefine = projectedSize > CONFIG.REFINEMENT_THRESHOLD && canHaveChildren;
            
            // Calculate distance for sorting
            const worldBox = node.boundingBox.clone();
            worldBox.applyMatrix4(this.cloud.matrixWorld);
            const center = new THREE.Vector3();
            worldBox.getCenter(center);
            node.distance = camera.position.distanceTo(center);
            
            // Add node as candidate if significant enough
            if (projectedSize > CONFIG.MIN_NODE_PIXEL_SIZE || node.level === 0) {
                candidates.push({
                    node: node,
                    screenSize: projectedSize,
                    distance: node.distance,
                    level: node.level
                });
            }
            
            // FIXED: More aggressive recursion - recurse if:
            // 1. Node should be refined (large on screen and has/might have children), OR
            // 2. Node is at low level (always explore top levels), OR
            // 3. Hierarchy not loaded yet but screen size is significant (need to explore)
            const shouldRecurse = node.shouldRefine || 
                                  node.level < 3 || 
                                  (projectedSize > CONFIG.MIN_NODE_PIXEL_SIZE * 2 && node.hierarchyLoaded);
            
            if (shouldRecurse) {
                for (const child of node.children) {
                    if (child) {
                        this._collectCandidates(child, camera, screenSize, candidates);
                    }
                }
            }
        }

        _addNodeToScene(node) {
            if (!node.points || node.isInScene) return;
            
            node.points.matrix.copy(this.cloud.matrixWorld);
            node.points.matrixWorld.copy(this.cloud.matrixWorld);
            
            this.extension.addNodeToScene(node);
            node.isInScene = true;
            this.visibleNodes.add(node);
        }

        _removeNodeFromScene(node) {
            if (!node.points || !node.isInScene) return;
            
            this.extension.removeNodeFromScene(node);
            node.isInScene = false;
            this.visibleNodes.delete(node);
            this._debugStats.unloadedCount++;
        }

        _updateSceneVisibility(finalVisibleNodes) {
            // Remove nodes that should no longer be visible
            const nodesToRemove = [];
            for (const node of this.visibleNodes) {
                if (!finalVisibleNodes.has(node)) {
                    nodesToRemove.push(node);
                }
            }
            
            for (const node of nodesToRemove) {
                this._removeNodeFromScene(node);
            }
            
            // Add nodes that should now be visible
            for (const node of finalVisibleNodes) {
                if (node.loaded && node.points && !node.isInScene) {
                    this._addNodeToScene(node);
                }
            }
        }

        _calculateActualRenderedPoints() {
            let total = 0;
            for (const node of this.visibleNodes) {
                total += node.numPoints || 0;
            }
            return total;
        }

        _logDebugStats() {
            const camera = this.extension.viewer.impl.camera;
            const camPos = camera.position;
            
            // Count levels represented
            const levelCounts = {};
            let maxLevel = 0;
            for (const node of this.visibleNodes) {
                levelCounts[node.level] = (levelCounts[node.level] || 0) + 1;
                maxLevel = Math.max(maxLevel, node.level);
            }
            
            console.log('[PotreeScheduler LOD]', {
                frame: this.frameCount,
                camDist: camPos.length().toFixed(1),
                selected: this._debugStats.selectedCount,
                visible: this._debugStats.visibleCount,
                loading: this.loadingNodes.size,
                points: this._debugStats.totalPoints.toLocaleString(),
                refined: this._debugStats.refinedCount,
                keptParents: this._debugStats.keptParentsCount,
                maxLevel: maxLevel,
                levelDist: Object.entries(levelCounts).map(([l, c]) => `L${l}:${c}`).join(' '),
                budget: CONFIG.POINT_BUDGET.toLocaleString(),
                budgetUsage: ((this._debugStats.totalPoints / CONFIG.POINT_BUDGET) * 100).toFixed(1) + '%'
            });
        }

        dispose() {
            for (const node of this.visibleNodes) {
                this._removeNodeFromScene(node);
                node.dispose();
            }
            this.visibleNodes.clear();
            this.loadingNodes.clear();
            this.selectedNodes.clear();
            this._disposeNodeTree(this.cloud.root);
        }

        _disposeNodeTree(node) {
            if (!node) return;
            
            if (node.points) {
                this._removeNodeFromScene(node);
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
    // FORGE POTREE POINT CLOUD EXTENSION
    // ========================================================================

    class ForgePotreePointCloudExtension extends Autodesk.Viewing.Extension {
        constructor(viewer, options) {
            super(viewer, options);
            
            this.clouds = new Map();        // name -> PotreeCloud (1.x)
            this.clouds2 = new Map();       // name -> Potree2PointCloud (2.0)
            this.schedulers = new Map();    // name -> PotreeScheduler
            this.potree2Loader = null;      // Potree2Loader instance
            this.overlayName = 'potreePointCloudOverlay';
            
            this._updateBound = this._onUpdate.bind(this);
            this._cameraChangeBound = this._onCameraChange.bind(this);
            
            this._enabled = true;
        }

        load() {
            log('Loading ForgePotreePointCloudExtension...');
            
            // Create overlay scene
            if (!this.viewer.impl.overlayScenes[this.overlayName]) {
                this.viewer.impl.createOverlayScene(this.overlayName);
            }
            
            // Initialize Potree2Loader if available
            if (typeof Potree2Loader !== 'undefined') {
                this.potree2Loader = new Potree2Loader(this);
                log('Potree2Loader initialized - Potree 2.0 format supported');
            }
            
            // Subscribe to camera changes
            this.viewer.addEventListener(
                Autodesk.Viewing.CAMERA_CHANGE_EVENT,
                this._cameraChangeBound
            );
            
            log('ForgePotreePointCloudExtension loaded successfully');
            return true;
        }

        unload() {
            log('Unloading ForgePotreePointCloudExtension...');
            
            // Remove event listener
            this.viewer.removeEventListener(
                Autodesk.Viewing.CAMERA_CHANGE_EVENT,
                this._cameraChangeBound
            );
            
            // Dispose all clouds
            for (const [name, scheduler] of this.schedulers) {
                scheduler.dispose();
            }
            this.schedulers.clear();
            this.clouds.clear();
            
            // Remove overlay scene
            if (this.viewer.impl.overlayScenes[this.overlayName]) {
                this.viewer.impl.removeOverlayScene(this.overlayName);
            }
            
            log('ForgePotreePointCloudExtension unloaded');
            return true;
        }

        // ====================================================================
        // PUBLIC API
        // ====================================================================

        /**
         * Detect Potree format from URL
         * @param {string} url - URL to metadata file
         * @returns {string} '1.x' or '2.0'
         */
        _detectFormat(url) {
            if (url.endsWith('metadata.json')) {
                return '2.0';
            }
            return '1.x';
        }

        /**
         * Load a Potree point cloud (auto-detects format)
         * @param {string} name - Unique name for the cloud
         * @param {string} cloudJsUrl - URL to cloud.js (1.x) or metadata.json (2.0)
         * @param {Object} options - Optional transform options
         * @returns {Promise<PotreeCloud|Potree2PointCloud>}
         */
        async loadPointCloud(name, cloudJsUrl, options = {}) {
            if (this.clouds.has(name) || this.clouds2.has(name)) {
                log(`Cloud '${name}' already loaded`);
                return this.clouds.get(name) || this.clouds2.get(name);
            }

            const format = this._detectFormat(cloudJsUrl);
            log(`Loading point cloud '${name}' from ${cloudJsUrl} (format: ${format})`);

            if (format === '2.0') {
                return this._loadPotree2(name, cloudJsUrl, options);
            } else {
                return this._loadPotree1(name, cloudJsUrl, options);
            }
        }

        /**
         * Load Potree 2.0 format point cloud
         */
        async _loadPotree2(name, metadataUrl, options = {}) {
            if (!this.potree2Loader) {
                throw new Error('Potree2Loader not available. Include Potree2Loader.js before this extension.');
            }

            try {
                const cloud = await this.potree2Loader.load(name, metadataUrl, options);
                this.clouds2.set(name, cloud);
                
                this._onCameraChange();
                
                log(`Potree 2.0 point cloud '${name}' loaded successfully`);
                log(`  - Total points: ${cloud.points.toLocaleString()}`);
                log(`  - Bounding box:`, cloud.boundingBox);
                
                return cloud;
                
            } catch (err) {
                error(`Failed to load Potree 2.0 point cloud '${name}':`, err);
                throw err;
            }
        }

        /**
         * Load Potree 1.x format point cloud
         */
        async _loadPotree1(name, cloudJsUrl, options = {}) {
            try {
                // Fetch cloud.js
                const response = await fetch(cloudJsUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch cloud.js: HTTP ${response.status}`);
                }
                
                const metadata = await response.json();
                
                // Create cloud
                const cloud = new PotreeCloud(cloudJsUrl, metadata);
                
                // Apply transform options
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
                
                // Create root node
                cloud.root = new PotreeNode('r', cloud);
                
                // Create scheduler
                const scheduler = new PotreeScheduler(cloud, this);
                
                // Load root hierarchy
                await scheduler.hierarchyLoader.loadHierarchy(cloud.root);
                
                // Load root node immediately
                await scheduler.nodeLoader.loadNode(cloud.root);
                
                if (cloud.root.loaded && cloud.root.points) {
                    this.addNodeToScene(cloud.root);
                }
                
                // Store
                this.clouds.set(name, cloud);
                this.schedulers.set(name, scheduler);
                
                // Trigger initial update
                this._onCameraChange();
                
                log(`Potree 1.x point cloud '${name}' loaded successfully`);
                log(`  - Points in root: ${cloud.root.numPoints}`);
                log(`  - Bounding box:`, cloud.boundingBox);
                
                return cloud;
                
            } catch (err) {
                error(`Failed to load Potree 1.x point cloud '${name}':`, err);
                throw err;
            }
        }

        /**
         * Unload a point cloud
         * @param {string} name - Name of the cloud to unload
         */
        unloadPointCloud(name) {
            // Potree 1.x
            if (this.clouds.has(name)) {
                const scheduler = this.schedulers.get(name);
                if (scheduler) {
                    scheduler.dispose();
                    this.schedulers.delete(name);
                }
                this.clouds.delete(name);
                log(`Potree 1.x point cloud '${name}' unloaded`);
            }
            
            // Potree 2.0
            if (this.clouds2.has(name)) {
                if (this.potree2Loader) {
                    this.potree2Loader.unload(name);
                }
                this.clouds2.delete(name);
                log(`Potree 2.0 point cloud '${name}' unloaded`);
            }
            
            this.viewer.impl.invalidate(true);
        }

        /**
         * Set visibility of a point cloud
         * @param {string} name - Name of the cloud
         * @param {boolean} visible - Visibility state
         */
        setPointCloudVisible(name, visible) {
            // Potree 1.x
            const cloud = this.clouds.get(name);
            if (cloud) {
                cloud.visible = visible;
                
                const scheduler = this.schedulers.get(name);
                if (scheduler) {
                    for (const node of scheduler.visibleNodes) {
                        if (node.points) {
                            node.points.visible = visible;
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Point cloud '${name}' visibility: ${visible}`);
                return;
            }
            
            // Potree 2.0
            const cloud2 = this.clouds2.get(name);
            if (cloud2) {
                cloud2.visible = visible;
                
                const scheduler2 = this.potree2Loader?.getScheduler(name);
                if (scheduler2) {
                    for (const node of scheduler2.visibleNodes) {
                        if (node.points) {
                            node.points.visible = visible;
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Point cloud '${name}' visibility: ${visible}`);
            }
        }

        /**
         * Toggle visibility of a point cloud
         * @param {string} name - Name of the cloud
         */
        togglePointCloud(name) {
            const cloud = this.clouds.get(name);
            if (cloud) {
                this.setPointCloudVisible(name, !cloud.visible);
                return;
            }
            
            const cloud2 = this.clouds2.get(name);
            if (cloud2) {
                this.setPointCloudVisible(name, !cloud2.visible);
            }
        }

        /**
         * Enable/disable the extension
         * @param {boolean} enabled
         */
        setEnabled(enabled) {
            this._enabled = enabled;
            
            for (const cloud of this.clouds.values()) {
                cloud.visible = enabled;
            }
            
            this.viewer.impl.invalidate(true);
            log(`Extension enabled: ${enabled}`);
        }

        /**
         * Set rotation for a cloud (in radians)
         * @param {string} name - Name of the cloud
         * @param {number} x - Rotation around X axis (radians)
         * @param {number} y - Rotation around Y axis (radians)
         * @param {number} z - Rotation around Z axis (radians)
         */
        setRotation(name, x, y, z) {
            // Potree 1.x
            const cloud = this.clouds.get(name);
            if (cloud) {
                cloud.rotation.set(x, y, z);
                cloud.updateMatrixWorld();
                
                // Update all visible nodes with new matrix
                const scheduler = this.schedulers.get(name);
                if (scheduler) {
                    for (const node of scheduler.visibleNodes) {
                        if (node.points) {
                            node.points.matrix.copy(cloud.matrixWorld);
                            node.points.matrixWorld.copy(cloud.matrixWorld);
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Rotation set for '${name}': (${(x * 180 / Math.PI).toFixed(1)}°, ${(y * 180 / Math.PI).toFixed(1)}°, ${(z * 180 / Math.PI).toFixed(1)}°)`);
                return;
            }
            
            // Potree 2.0
            const cloud2 = this.clouds2.get(name);
            if (cloud2) {
                cloud2.rotation.set(x, y, z);
                cloud2.updateMatrixWorld();
                
                // Update all visible nodes with new matrix
                const scheduler2 = this.potree2Loader?.getScheduler(name);
                if (scheduler2) {
                    for (const node of scheduler2.visibleNodes) {
                        if (node.points) {
                            node.points.matrix.copy(cloud2.matrixWorld);
                            node.points.matrixWorld.copy(cloud2.matrixWorld);
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Rotation set for '${name}': (${(x * 180 / Math.PI).toFixed(1)}°, ${(y * 180 / Math.PI).toFixed(1)}°, ${(z * 180 / Math.PI).toFixed(1)}°)`);
            }
        }

        /**
         * Set position for a cloud
         * @param {string} name - Name of the cloud
         * @param {number} x - X position
         * @param {number} y - Y position
         * @param {number} z - Z position
         */
        setPosition(name, x, y, z) {
            // Potree 1.x
            const cloud = this.clouds.get(name);
            if (cloud) {
                cloud.position.set(x, y, z);
                cloud.updateMatrixWorld();
                
                // Update all visible nodes with new matrix
                const scheduler = this.schedulers.get(name);
                if (scheduler) {
                    for (const node of scheduler.visibleNodes) {
                        if (node.points) {
                            node.points.matrix.copy(cloud.matrixWorld);
                            node.points.matrixWorld.copy(cloud.matrixWorld);
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Position set for '${name}': (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
                return;
            }
            
            // Potree 2.0
            const cloud2 = this.clouds2.get(name);
            if (cloud2) {
                cloud2.position.set(x, y, z);
                cloud2.updateMatrixWorld();
                
                // Update all visible nodes with new matrix
                const scheduler2 = this.potree2Loader?.getScheduler(name);
                if (scheduler2) {
                    for (const node of scheduler2.visibleNodes) {
                        if (node.points) {
                            node.points.matrix.copy(cloud2.matrixWorld);
                            node.points.matrixWorld.copy(cloud2.matrixWorld);
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Position set for '${name}': (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
            }
        }

        /**
         * Set scale for a cloud
         * @param {string} name - Name of the cloud
         * @param {number} scale - Uniform scale factor
         */
        setScale(name, scale) {
            // Potree 1.x
            const cloud = this.clouds.get(name);
            if (cloud) {
                cloud.scale3.set(scale, scale, scale);
                cloud.updateMatrixWorld();
                
                // Update all visible nodes with new matrix
                const scheduler = this.schedulers.get(name);
                if (scheduler) {
                    for (const node of scheduler.visibleNodes) {
                        if (node.points) {
                            node.points.matrix.copy(cloud.matrixWorld);
                            node.points.matrixWorld.copy(cloud.matrixWorld);
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Scale set for '${name}': ${scale.toFixed(2)}`);
                return;
            }
            
            // Potree 2.0
            const cloud2 = this.clouds2.get(name);
            if (cloud2) {
                cloud2.scale3.set(scale, scale, scale);
                cloud2.updateMatrixWorld();
                
                // Update all visible nodes with new matrix
                const scheduler2 = this.potree2Loader?.getScheduler(name);
                if (scheduler2) {
                    for (const node of scheduler2.visibleNodes) {
                        if (node.points) {
                            node.points.matrix.copy(cloud2.matrixWorld);
                            node.points.matrixWorld.copy(cloud2.matrixWorld);
                        }
                    }
                }
                
                this.viewer.impl.invalidate(true);
                log(`Scale set for '${name}': ${scale.toFixed(2)}`);
            }
        }

        /**
         * Get current transform of a cloud
         * @param {string} name - Name of the cloud
         * @returns {Object|null} Transform object with position, rotation, scale
         */
        getTransform(name) {
            const cloud = this.clouds.get(name) || this.clouds2.get(name);
            if (cloud) {
                return {
                    position: cloud.position.clone(),
                    rotation: cloud.rotation.clone(),
                    scale: cloud.scale3.clone()
                };
            }
            return null;
        }

        /**
         * Set point size for a cloud
         * @param {string} name - Name of the cloud
         * @param {number} size - Point size in pixels
         */
        setPointSize(name, size) {
            const scheduler = this.schedulers.get(name);
            if (scheduler) {
                for (const node of scheduler.visibleNodes) {
                    if (node.material) {
                        node.material.size = size;
                    }
                }
                this.viewer.impl.invalidate(true);
            }
        }

        /**
         * Set point budget
         * @param {number} budget - Max points to render
         */
        setPointBudget(budget) {
            CONFIG.POINT_BUDGET = budget;
            log(`Point budget set to: ${budget.toLocaleString()}`);
        }

        /**
         * Set refinement threshold (screen pixels)
         * Lower = more aggressive refinement (finer detail)
         * Higher = less refinement (coarser detail, better performance)
         * @param {number} threshold - Pixels threshold for refinement
         */
        setRefinementThreshold(threshold) {
            CONFIG.REFINEMENT_THRESHOLD = threshold;
            log(`Refinement threshold set to: ${threshold}px`);
        }

        /**
         * Enable/disable LOD debug logging
         * @param {boolean} enabled
         */
        setLODDebug(enabled) {
            CONFIG.DEBUG_LOD = enabled;
            log(`LOD debug logging: ${enabled}`);
        }

        /**
         * COMPREHENSIVE DEBUG - Call from console: potreeExt.debugNow()
         */
        debugNow() {
            console.log('='.repeat(60));
            console.log('POTREE DEBUG SNAPSHOT');
            console.log('='.repeat(60));

            // Show Potree 1.x config if there are 1.x clouds
            if (this.clouds.size > 0) {
                console.log('\n📊 POTREE 1.x CONFIG:');
                console.log('  POINT_BUDGET:', CONFIG.POINT_BUDGET.toLocaleString());
                console.log('  MIN_NODE_PIXEL_SIZE:', CONFIG.MIN_NODE_PIXEL_SIZE);
                console.log('  REFINEMENT_THRESHOLD:', CONFIG.REFINEMENT_THRESHOLD);
                console.log('  MAX_CONCURRENT_LOADS:', CONFIG.MAX_CONCURRENT_LOADS);
            }
            
            // Show Potree 2.0 config if there are 2.0 clouds
            if (this.clouds2.size > 0 && window.POTREE2_CONFIG) {
                const P2CFG = window.POTREE2_CONFIG;
                console.log('\n📊 POTREE 2.0 CONFIG:');
                console.log('  POINT_BUDGET:', P2CFG.POINT_BUDGET?.toLocaleString() || 'N/A');
                console.log('  MIN_NODE_PIXEL_SIZE:', P2CFG.MIN_NODE_PIXEL_SIZE);
                console.log('  REFINEMENT_THRESHOLD:', P2CFG.REFINEMENT_THRESHOLD);
                console.log('  MAX_CONCURRENT_LOADS:', P2CFG.MAX_CONCURRENT_LOADS);
                console.log('  DEBUG_LOD:', P2CFG.DEBUG_LOD);
            }
            
            const camera = this.viewer.impl.camera;
            console.log('\n📷 CAMERA:');
            console.log('  Position:', camera.position.toArray().map(v => v.toFixed(2)));
            console.log('  FOV:', camera.fov);
            
            // Potree 1.x clouds
            for (const [name, cloud] of this.clouds) {
                console.log(`\n☁️ CLOUD "${name}" (Potree 1.x):`);
                console.log('  Visible:', cloud.visible);
                console.log('  BoundingBox:', {
                    min: cloud.boundingBox.min.toArray().map(v => v.toFixed(2)),
                    max: cloud.boundingBox.max.toArray().map(v => v.toFixed(2))
                });
                
                const scheduler = this.schedulers.get(name);
                if (scheduler) {
                    console.log('  📈 SCHEDULER:');
                    console.log('    visibleNodes:', scheduler.visibleNodes.size);
                    console.log('    loadingNodes:', scheduler.loadingNodes.size);
                    console.log('    renderedPoints:', scheduler.renderedPoints.toLocaleString());
                    
                    // List visible nodes
                    console.log('    📋 VISIBLE NODES:');
                    let nodeIndex = 0;
                    for (const node of scheduler.visibleNodes) {
                        if (nodeIndex < 10) {
                            console.log(`      [${node.name}] level=${node.level} pts=${node.numPoints} loaded=${node.loaded} inScene=${node.isInScene} screenSize=${node.screenSize?.toFixed(0) || '?'}`);
                        }
                        nodeIndex++;
                    }
                    if (nodeIndex > 10) {
                        console.log(`      ... and ${nodeIndex - 10} more nodes`);
                    }
                    
                    // Check for issues
                    let loadedCount = 0;
                    let inSceneCount = 0;
                    let parentIssues = [];
                    
                    for (const node of scheduler.visibleNodes) {
                        if (node.loaded) loadedCount++;
                        if (node.isInScene) inSceneCount++;
                        
                        // Check if parent should be visible
                        if (node.parent && !node.loaded) {
                            if (!scheduler.visibleNodes.has(node.parent)) {
                                parentIssues.push(node.name);
                            }
                        }
                    }
                    
                    console.log('    🔍 ANALYSIS:');
                    console.log('      Loaded nodes:', loadedCount, '/', scheduler.visibleNodes.size);
                    console.log('      In scene:', inSceneCount, '/', scheduler.visibleNodes.size);
                    
                    if (parentIssues.length > 0) {
                        console.warn('    ⚠️ PARENT ISSUES:', parentIssues);
                    }
                }
            }
            
            // Potree 2.0 clouds
            for (const [name, cloud] of this.clouds2) {
                console.log(`\n☁️ CLOUD "${name}" (Potree 2.0):`);
                console.log('  Visible:', cloud.visible);
                console.log('  Total Points:', cloud.points?.toLocaleString());
                console.log('  Root:', cloud.root ? `${cloud.root.name} hasChildren=${cloud.root.hasChildren}` : 'null');
                
                // Count children in hierarchy and max depth
                if (cloud.root) {
                    let totalNodesInHierarchy = 0;
                    let maxLevel = 0;
                    let nodesAtLevel = {};
                    
                    const countNodes = (node) => {
                        if (!node) return;
                        totalNodesInHierarchy++;
                        maxLevel = Math.max(maxLevel, node.level);
                        nodesAtLevel[node.level] = (nodesAtLevel[node.level] || 0) + 1;
                        
                        for (const child of node.children) {
                            if (child) countNodes(child);
                        }
                    };
                    countNodes(cloud.root);
                    console.log('  Total nodes in hierarchy:', totalNodesInHierarchy);
                    console.log('  Max depth level:', maxLevel);
                    console.log('  Nodes per level:', nodesAtLevel);
                    
                    // Show children of root
                    const rootChildren = cloud.root.children.filter(c => c).map(c => c.name);
                    console.log('  Root children:', rootChildren.length > 0 ? rootChildren.join(', ') : 'NONE');
                }
                
                const scheduler = this.potree2Loader?.getScheduler(name);
                if (scheduler) {
                    console.log('  📈 SCHEDULER:');
                    console.log('    visibleNodes:', scheduler.visibleNodes.size);
                    console.log('    loadingNodes:', scheduler.loadingNodes.size);
                    console.log('    renderedPoints:', scheduler.renderedPoints.toLocaleString());
                    console.log('    frameCount:', scheduler.frameCount);
                    
                    // Manual candidate collection for debugging
                    const camera = this.viewer.impl.camera;
                    const screenSize = { x: this.viewer.container.clientWidth, y: this.viewer.container.clientHeight };
                    const testCandidates = [];
                    
                    // Simple recursive collect
                    const collectTest = (node, depth = 0) => {
                        if (!node || depth > 6) return;
                        const worldBox = node.boundingBox.clone();
                        worldBox.applyMatrix4(cloud.matrixWorld);
                        const center = new THREE.Vector3();
                        worldBox.getCenter(center);
                        const dist = camera.position.distanceTo(center);
                        
                        testCandidates.push({ 
                            name: node.name, 
                            level: node.level, 
                            dist: dist.toFixed(1), 
                            hasChildren: node.hasChildren,
                            childCount: node.children.filter(c=>c).length,
                            loaded: node.loaded,
                            pts: node.numPoints
                        });
                        
                        for (const child of node.children) {
                            if (child) collectTest(child, depth + 1);
                        }
                    };
                    
                    collectTest(cloud.root);
                    console.log('  🔍 HIERARCHY CHECK (first 15 nodes by traversal):');
                    testCandidates.slice(0, 15).forEach(c => {
                        console.log(`    [${c.name}] lv=${c.level} dist=${c.dist} pts=${c.pts} children=${c.childCount} loaded=${c.loaded}`);
                    });
                    
                    // Show visible nodes details
                    if (scheduler.visibleNodes.size > 0) {
                        console.log('    📋 VISIBLE NODES:');
                        let idx = 0;
                        for (const node of scheduler.visibleNodes) {
                            if (idx < 15) {
                                console.log(`      [${node.name}] level=${node.level} pts=${node.numPoints} screenSize=${node.screenSize?.toFixed(0) || '?'} dist=${node.distance?.toFixed(1) || '?'} hasChildren=${node.hasChildren} loaded=${node.loaded}`);
                            }
                            idx++;
                        }
                        if (idx > 15) console.log(`      ... and ${idx - 15} more`);
                    }
                    
                    // Analyze why we might have few nodes
                    console.log('  ⚠️ DIAGNOSTIC:');
                    const loadedCount = Array.from(scheduler.visibleNodes).filter(n => n.loaded).length;
                    console.log(`    Loaded in visible: ${loadedCount}/${scheduler.visibleNodes.size}`);
                    
                    // Check root children loading state
                    if (cloud.root) {
                        const childrenStates = cloud.root.children.filter(c => c).map(c => 
                            `${c.name}:loaded=${c.loaded},inScene=${c.isInScene}`
                        );
                        console.log('    Root children states:', childrenStates.join(', ') || 'no children');
                    }
                }
            }
            
            console.log('\n' + '='.repeat(60));
            return 'Debug complete. Check console for details.';
        }

        /**
         * Force all nodes to reload
         */
        forceReload(cloudName) {
            const scheduler = this.schedulers.get(cloudName);
            if (scheduler) {
                // Clear visible nodes
                for (const node of scheduler.visibleNodes) {
                    this.removeNodeFromScene(node);
                }
                scheduler.visibleNodes.clear();
                scheduler.loadingNodes.clear();
                scheduler.selectedNodes.clear();
                
                // Trigger update
                this._onCameraChange();
                log(`Force reloaded cloud: ${cloudName}`);
            }
        }

        /**
         * Set minimum node pixel size - LOWER = MORE DETAIL
         */
        setMinNodeSize(size) {
            CONFIG.MIN_NODE_PIXEL_SIZE = size;
            log(`MIN_NODE_PIXEL_SIZE set to: ${size}`);
        }

        /**
         * Get current LOD configuration
         * @returns {Object}
         */
        getLODConfig() {
            return {
                pointBudget: CONFIG.POINT_BUDGET,
                refinementThreshold: CONFIG.REFINEMENT_THRESHOLD,
                minNodePixelSize: CONFIG.MIN_NODE_PIXEL_SIZE,
                maxConcurrentLoads: CONFIG.MAX_CONCURRENT_LOADS,
                updateInterval: CONFIG.UPDATE_INTERVAL,
                debugLOD: CONFIG.DEBUG_LOD
            };
        }

        /**
         * Get statistics
         * @returns {Object} Stats object
         */
        getStats() {
            let totalPoints = 0;
            let totalNodes = 0;
            
            // Potree 1.x stats
            for (const scheduler of this.schedulers.values()) {
                totalPoints += scheduler.renderedPoints;
                totalNodes += scheduler.visibleNodes.size;
            }
            
            // Potree 2.0 stats
            if (this.potree2Loader) {
                const p2Stats = this.potree2Loader.getStats();
                totalPoints += p2Stats.totalPoints;
                totalNodes += p2Stats.totalNodes;
            }
            
            return {
                totalPoints,
                totalNodes,
                cloudsLoaded: this.clouds.size + this.clouds2.size,
                pointBudget: CONFIG.POINT_BUDGET
            };
        }

        /**
         * Get loaded cloud names
         * @returns {Array<string>}
         */
        getCloudNames() {
            return Array.from(this.clouds.keys());
        }

        // ====================================================================
        // INTERNAL METHODS
        // ====================================================================

        addNodeToScene(node) {
            if (!node.points) return;
            
            // Update matrix
            node.points.matrix.copy(node.cloud.matrixWorld);
            node.points.matrixWorld.copy(node.cloud.matrixWorld);
            
            this.viewer.impl.addOverlay(this.overlayName, node.points);
        }

        removeNodeFromScene(node) {
            if (!node.points) return;
            
            this.viewer.impl.removeOverlay(this.overlayName, node.points);
        }

        _onCameraChange() {
            if (!this._enabled) return;
            
            const camera = this.viewer.impl.camera;
            
            // Get canvas size (Forge renderer doesn't have getSize like standard THREE.WebGLRenderer)
            const canvas = this.viewer.impl.canvas;
            const screenSize = new THREE.Vector2(canvas.width, canvas.height);
            
            // Update Potree 1.x clouds
            for (const scheduler of this.schedulers.values()) {
                scheduler.update(camera, screenSize);
            }
            
            // Update Potree 2.0 clouds
            if (this.potree2Loader) {
                this.potree2Loader.update(camera, screenSize);
            }
            
            this.viewer.impl.invalidate(true);
        }

        _onUpdate() {
            this._onCameraChange();
        }
    }

    // Register the extension
    Autodesk.Viewing.theExtensionManager.registerExtension(
        'ForgePotreePointCloudExtension',
        ForgePotreePointCloudExtension
    );

    // Export for external access
    window.ForgePotreePointCloudExtension = ForgePotreePointCloudExtension;
    window.PotreeCloud = PotreeCloud;
    window.PotreeNode = PotreeNode;
    window.PotreeScheduler = PotreeScheduler;
    
    // Export CONFIG for easy console debugging
    window.POTREE_CONFIG = CONFIG;

    log('ForgePotreePointCloudExtension registered');
    log('DEBUG: Use potreeExt.debugNow() in console to inspect state');
    log('DEBUG: Use window.POTREE_CONFIG to view/modify config');
    
    // Debug: log available THREE classes after a delay (to ensure THREE is loaded)
    setTimeout(() => {
        if (typeof THREE !== 'undefined') {
            log('THREE.Points:', typeof THREE.Points);
            log('THREE.PointCloud:', typeof THREE.PointCloud);
            log('THREE.PointsMaterial:', typeof THREE.PointsMaterial);
            log('THREE.PointCloudMaterial:', typeof THREE.PointCloudMaterial);
            log('THREE.Mesh:', typeof THREE.Mesh);
            log('THREE.BufferGeometry:', typeof THREE.BufferGeometry);
        } else {
            warn('THREE not available yet');
        }
    }, 1000);

})();

// ============================================================================
// USAGE EXAMPLE (add to your HTML after loading the extension):
// ============================================================================
/*

// 1. Load the extension when initializing the viewer:
const viewerConfig = {
    extensions: ['ForgePotreePointCloudExtension']
};
const viewer = new Autodesk.Viewing.GuiViewer3D(container, viewerConfig);

// 2. After viewer is ready, load a point cloud:
const ext = viewer.getExtension('ForgePotreePointCloudExtension');

// Load with default transform
await ext.loadPointCloud('myCloud', '/potree-data/lion_takanawa/cloud.js');

// Or with custom transform
await ext.loadPointCloud('myCloud2', '/potree-data/other/cloud.js', {
    position: new THREE.Vector3(10, 0, 0),
    scale: 5
});

// 3. Control the point cloud:
ext.setPointCloudVisible('myCloud', false);  // Hide
ext.togglePointCloud('myCloud');              // Toggle
ext.setPointSize('myCloud', 3);               // Change point size
ext.setPointBudget(5000000);                  // Increase budget
ext.unloadPointCloud('myCloud');              // Unload

// 4. Get stats:
console.log(ext.getStats());

// 5. Enable/disable all:
ext.setEnabled(false);

*/

// ============================================================================
// TODO LIST FOR FUTURE IMPROVEMENTS:
// ============================================================================
/*

TODO: Implement intensity colormap
  - Add shader-based colormap (grayscale, rainbow, etc.)
  - Pass intensity as attribute to shader
  - Add UI controls for colormap selection

TODO: Implement classification colormap
  - Define color palette per classification (ground, vegetation, building, etc.)
  - Support standard LAS classification codes
  - Add filter by classification

TODO: Implement point picking
  - Use raycasting against loaded nodes
  - Return picked point position and attributes
  - Integrate with Forge Viewer selection system

TODO: Implement clash detection preparation
  - Add method to get points within a bounding box
  - Support intersection with BIM elements
  - Export point selection for analysis

TODO: Optimize memory management
  - Implement LRU cache for node disposal
  - Add configurable memory limit
  - Dispose textures and geometry properly

TODO: Add point cloud editing
  - Support clipping planes/boxes
  - Implement point deletion
  - Add color override per selection

TODO: Improve rendering
  - Add EDL (Eye-Dome Lighting) shader
  - Support point shapes (circle, square, paraboloid)
  - Implement adaptive point size

TODO: Support other Potree versions
  - Add Potree 2.0 (copc, ept) support
  - Handle different hierarchy formats
  - Support compressed point data

*/
