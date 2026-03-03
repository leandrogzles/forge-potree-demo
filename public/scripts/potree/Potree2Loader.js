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
            
            // LOD state tracking
            this.isInScene = false;
            this.shouldRefine = false;
            this.lastVisibleTime = 0;
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
    
    // Node types in Potree 2.0
    const NODE_TYPE = {
        NORMAL: 0,  // Regular inner node
        LEAF: 1,    // Leaf node (no children)
        PROXY: 2    // Lazy load marker - children at different offset
    };

    class Potree2HierarchyParser {
        constructor(cloud) {
            this.cloud = cloud;
            this.bytesPerNode = 22;
        }

        parse(hierarchyBuffer) {
            const view = new DataView(hierarchyBuffer);
            const bufferSize = hierarchyBuffer.byteLength;
            const maxNodes = Math.floor(bufferSize / this.bytesPerNode);
            
            log(`Parsing hierarchy: buffer=${bufferSize} bytes, max ${maxNodes} nodes`);
            log(`Hierarchy config:`, this.cloud.hierarchy);
            
            const nodes = new Map();
            const root = new Potree2Node('r', this.cloud);
            nodes.set('r', root);
            
            // Potree 2.0 hierarchy is depth-first encoded
            // Parse recursively starting at offset 0
            const result = this._parseNodeRecursive(view, 0, root, nodes, bufferSize);
            
            log(`Hierarchy parsed: ${nodes.size} nodes, consumed ${result.nextOffset} bytes`);
            
            // Log level distribution
            const levelCounts = {};
            let maxLevel = 0;
            for (const [name, node] of nodes) {
                levelCounts[node.level] = (levelCounts[node.level] || 0) + 1;
                maxLevel = Math.max(maxLevel, node.level);
            }
            log(`Nodes per level:`, levelCounts);
            log(`Max depth: ${maxLevel}`);
            
            return { root, nodes };
        }
        
        /**
         * Recursively parse node and all its children (depth-first)
         * Returns { nextOffset } - the offset after this node's subtree
         */
        _parseNodeRecursive(view, offset, node, nodes, bufferSize) {
            if (offset + this.bytesPerNode > bufferSize) {
                warn(`Offset ${offset} exceeds buffer for node ${node.name}`);
                return { nextOffset: offset };
            }
            
            // Read node data
            const type = view.getUint8(offset);
            const childMask = view.getUint8(offset + 1);
            const numPoints = view.getUint32(offset + 2, true);
            const byteOffset = Number(view.getBigInt64(offset + 6, true));
            const byteSize = Number(view.getBigInt64(offset + 14, true));
            
            // Log first few nodes and any PROXY nodes
            if (nodes.size < 20 || type === NODE_TYPE.PROXY) {
                const typeNames = ['NORMAL', 'LEAF', 'PROXY'];
                log(`Parse ${node.name}: type=${typeNames[type] || type}, mask=${childMask.toString(2).padStart(8,'0')}, pts=${numPoints}, offset=${byteOffset}, size=${byteSize}`);
            }
            
            node.numPoints = numPoints;
            node.nodeType = type;
            
            // For PROXY nodes: byteOffset/byteSize point to hierarchy.bin chunk
            // For NORMAL/LEAF: byteOffset/byteSize point to octree.bin data
            if (type === NODE_TYPE.PROXY) {
                // Store hierarchy chunk location for lazy loading
                node.hierarchyByteOffset = byteOffset;
                node.hierarchyByteSize = byteSize;
                // Point data location will be determined when loading children
                node.byteOffset = 0;
                node.byteSize = 0;
            } else {
                node.byteOffset = byteOffset;
                node.byteSize = byteSize;
            }
            
            let currentOffset = offset + this.bytesPerNode;
            
            // Count children
            let childCount = 0;
            for (let i = 0; i < 8; i++) {
                if (childMask & (1 << i)) childCount++;
            }
            
            if (type === NODE_TYPE.PROXY && childCount > 0) {
                // PROXY: children are at a different location in the buffer
                // Parse children from the proxy's hierarchy chunk
                let childOffset = byteOffset;
                
                for (let i = 0; i < 8; i++) {
                    if (childMask & (1 << i)) {
                        const childName = node.getChildName(i);
                        const child = new Potree2Node(childName, this.cloud, node);
                        node.addChild(i, child);
                        nodes.set(childName, child);
                        
                        // Recursively parse child at the proxy offset
                        const result = this._parseNodeRecursive(view, childOffset, child, nodes, bufferSize);
                        childOffset = result.nextOffset;
                    }
                }
                // Note: currentOffset stays the same since children are elsewhere
            } else if (childCount > 0) {
                // NORMAL or LEAF with children: children follow inline
                for (let i = 0; i < 8; i++) {
                    if (childMask & (1 << i)) {
                        const childName = node.getChildName(i);
                        const child = new Potree2Node(childName, this.cloud, node);
                        node.addChild(i, child);
                        nodes.set(childName, child);
                        
                        // Parse child recursively - it continues right after parent
                        const result = this._parseNodeRecursive(view, currentOffset, child, nodes, bufferSize);
                        currentOffset = result.nextOffset;
                    }
                }
            }
            
            return { nextOffset: currentOffset };
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
                    // Skip PROXY nodes (they don't have point data directly)
                    // Skip nodes with no data
                    if (node.nodeType === NODE_TYPE.PROXY || node.byteSize === 0 || node.numPoints === 0) {
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
            
            // Create material with optimized settings for LOD transitions
            const PointsMaterialClass = THREE.PointsMaterial || THREE.PointCloudMaterial;
            node.material = new PointsMaterialClass({
                size: 3,                    // Slightly larger points fill gaps better
                sizeAttenuation: true,      // Points scale with distance
                vertexColors: true,
                depthWrite: true,           // Allow proper depth sorting
                depthTest: true,
                transparent: false
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
    // POTREE 2.0 SCHEDULER (FIXED - Safe LOD management)
    // ========================================================================

    const POTREE2_CONFIG = {
        POINT_BUDGET: 15_000_000,          // Max points to render (increased)
        MAX_CONCURRENT_LOADS: 10,          // Concurrent loads (increased)
        MIN_NODE_PIXEL_SIZE: 10,           // Min screen size for selection (lowered)
        REFINEMENT_THRESHOLD: 50,          // Screen pixels threshold to refine (lowered)
        UPDATE_INTERVAL: 30,               // ms between updates (faster)
        DEBUG_LOD: true                    // Enable LOD debug logs (for debugging)
    };

    class Potree2Scheduler {
        constructor(cloud, extension, octreeBuffer) {
            this.cloud = cloud;
            this.extension = extension;
            this.nodeLoader = new Potree2NodeLoader(cloud, octreeBuffer);
            
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
            
            if (distance < 0.001) {
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
            return node.screenSize > POTREE2_CONFIG.REFINEMENT_THRESHOLD && node.hasChildren;
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
            
            return loadedChildrenCount >= 1;
        }

        /**
         * Check if a node is inside the view frustum
         * VERY lenient for close-up viewing
         */
        _isInFrustum(node) {
            const worldBox = node.boundingBox.clone();
            worldBox.applyMatrix4(this.cloud.matrixWorld);
            
            // Standard frustum test
            if (this.frustum.intersectsBox(worldBox)) {
                return true;
            }
            
            const camera = this.extension.viewer.impl.camera;
            
            // Camera inside bounding box
            if (worldBox.containsPoint(camera.position)) {
                return true;
            }
            
            // Check distance - be VERY generous
            const center = new THREE.Vector3();
            worldBox.getCenter(center);
            const size = new THREE.Vector3();
            worldBox.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const distance = camera.position.distanceTo(center);
            
            // If close, always consider visible
            if (distance < maxDim * 5) {
                return true;
            }
            
            // Level-based leniency: lower levels (bigger nodes) are more likely to be relevant
            if (node.level < 3 && distance < 200) {
                return true;
            }
            
            // Always include root
            if (node.level === 0) {
                return true;
            }
            
            return false;
        }

        async update(camera, screenSize) {
            const now = performance.now();
            if (now - this.lastUpdateTime < POTREE2_CONFIG.UPDATE_INTERVAL) {
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
            
            // Phase 1: Collect all candidate nodes
            const candidates = [];
            this._collectCandidates(this.cloud.root, camera, screenSize, candidates);
            
            // Phase 2: Sort by priority (closer/bigger first)
            candidates.sort((a, b) => {
                // Prioritize closer nodes at any level
                if (a.distance !== b.distance) {
                    return a.distance - b.distance;
                }
                // Then by screen size
                return b.screenSize - a.screenSize;
            });
            
            // Debug: Log candidates count and details
            if (this.frameCount < 10 || (POTREE2_CONFIG.DEBUG_LOD && this.frameCount % 60 === 0)) {
                console.log(`[Potree2] Phase 1: ${candidates.length} candidates collected`);
                console.log(`[Potree2] Candidates by level:`, candidates.reduce((acc, c) => {
                    acc[c.level] = (acc[c.level] || 0) + 1;
                    return acc;
                }, {}));
            }
            
            // Phase 3: Select ALL candidates (no budget filtering for now - debugging)
            const newSelectedNodes = new Set();
            let totalPoints = 0;
            
            for (const candidate of candidates) {
                const node = candidate.node;
                newSelectedNodes.add(node);
                totalPoints += node.numPoints;
                
                // Only apply budget to VERY excessive cases
                if (totalPoints > POTREE2_CONFIG.POINT_BUDGET * 2) {
                    break;
                }
            }
            
            this._debugStats.selectedCount = newSelectedNodes.size;
            this._debugStats.totalPoints = totalPoints;
            
            // Debug: Check for unloaded selected nodes
            if (this.frameCount < 10 || (POTREE2_CONFIG.DEBUG_LOD && this.frameCount % 60 === 0)) {
                const unloadedSelected = Array.from(newSelectedNodes).filter(n => !n.loaded && n.numPoints > 0);
                console.log(`[Potree2] Selected: ${newSelectedNodes.size}, Unloaded to queue: ${unloadedSelected.length}`);
                if (unloadedSelected.length > 0 && unloadedSelected.length < 20) {
                    console.log(`[Potree2] Unloaded nodes:`, unloadedSelected.map(n => `${n.name}(pts=${n.numPoints})`).join(', '));
                }
            }
            
            // Phase 4: Safe parent/child visibility management
            const finalVisibleNodes = new Set();
            
            for (const node of newSelectedNodes) {
                const parent = node.parent;
                
                if (node.loaded && node.points) {
                    finalVisibleNodes.add(node);
                    node.lastVisibleTime = now;
                }
                
                if (parent && parent.loaded && parent.points) {
                    const shouldRefineParent = this._shouldRefine(parent, screenSize);
                    
                    if (shouldRefineParent) {
                        if (this._childrenLoadedEnough(parent)) {
                            this._debugStats.refinedCount++;
                        } else {
                            if (!finalVisibleNodes.has(parent)) {
                                finalVisibleNodes.add(parent);
                                this._debugStats.keptParentsCount++;
                            }
                        }
                    }
                }
            }
            
            // Keep currently visible parents if children aren't ready
            for (const node of this.visibleNodes) {
                if (!finalVisibleNodes.has(node) && node.loaded && node.points) {
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
                    
                    if (childrenInSelection > 0 && childrenLoaded < childrenInSelection) {
                        finalVisibleNodes.add(node);
                        this._debugStats.keptParentsCount++;
                    }
                }
            }
            
            // Phase 5: Queue loading for selected but unloaded nodes
            const nodesToLoad = [];
            for (const node of newSelectedNodes) {
                if (!node.loaded && !node.loading && !node.failed && node.numPoints > 0) {
                    nodesToLoad.push(node);
                }
            }
            
            // Also add children of visible nodes that need refinement
            for (const node of this.visibleNodes) {
                if (node.shouldRefine && node.hasChildren) {
                    for (const child of node.children) {
                        if (child && !child.loaded && !child.loading && !child.failed && child.numPoints > 0) {
                            if (!nodesToLoad.includes(child)) {
                                nodesToLoad.push(child);
                            }
                        }
                    }
                }
            }
            
            // Sort by distance (closer first)
            nodesToLoad.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
            
            // Debug: Check loading queue
            if (this.frameCount < 10 || (POTREE2_CONFIG.DEBUG_LOD && this.frameCount % 60 === 0)) {
                console.log(`[Potree2] To load: ${nodesToLoad.length}, Currently loading: ${this.loadingNodes.size}`);
            }
            
            const currentLoading = this.loadingNodes.size;
            const canLoad = Math.max(0, POTREE2_CONFIG.MAX_CONCURRENT_LOADS - currentLoading);
            
            for (let i = 0; i < Math.min(nodesToLoad.length, canLoad); i++) {
                const node = nodesToLoad[i];
                this.loadingNodes.add(node);
                
                if (this.frameCount < 10) {
                    console.log(`[Potree2] Starting load: ${node.name} (pts=${node.numPoints}, byteSize=${node.byteSize})`);
                }
                
                this.nodeLoader.loadNode(node).then(() => {
                    this.loadingNodes.delete(node);
                    
                    if (node.loaded && node.points) {
                        this._addNodeToScene(node);
                    }
                }).catch(err => {
                    console.error(`[Potree2] Load failed for ${node.name}:`, err);
                    this.loadingNodes.delete(node);
                });
            }
            
            // Phase 6: Update scene visibility
            this._updateSceneVisibility(finalVisibleNodes);
            
            this.selectedNodes = newSelectedNodes;
            this._debugStats.visibleCount = this.visibleNodes.size;
            this.renderedPoints = this._calculateActualRenderedPoints();
            
            // Debug logging - more frequent
            if (POTREE2_CONFIG.DEBUG_LOD && this.frameCount % 20 === 0) {
                this._logDebugStats(candidates);
            }
        }

        _collectCandidates(node, camera, screenSize, candidates, depth = 0) {
            if (!node) return;
            
            // Higher depth limit
            if (depth > 15) return;
            
            // Calculate distance first (needed for leniency checks)
            const worldBox = node.boundingBox.clone();
            worldBox.applyMatrix4(this.cloud.matrixWorld);
            const center = new THREE.Vector3();
            worldBox.getCenter(center);
            const distance = camera.position.distanceTo(center);
            
            // Check frustum - VERY lenient
            const inFrustum = this._isInFrustum(node);
            
            // Calculate projected size
            const projectedSize = this._calculateScreenSpaceError(node, camera, screenSize);
            
            node.screenSize = projectedSize;
            node.distance = distance;
            
            // Debug logging for understanding hierarchy traversal
            const shouldLog = this.frameCount < 10 && depth < 5;
            if (shouldLog) {
                const childNames = node.children.filter(c=>c).map(c=>c.name).join(',');
                console.log(`[Collect] ${node.name}: depth=${depth}, dist=${distance.toFixed(1)}, screenSize=${projectedSize.toFixed(0)}, hasChildren=${node.hasChildren}, childCount=${node.children.filter(c=>c).length}, children=[${childNames}]`);
            }
            
            // Add ALL nodes to candidates if not too far
            // Much more inclusive
            const shouldAdd = distance < 500 || projectedSize > 5 || node.level === 0;
            if (shouldAdd) {
                candidates.push({
                    node: node,
                    screenSize: projectedSize,
                    distance: distance,
                    level: node.level
                });
            }
            
            // Determine if should refine
            const isClose = distance < 200;
            node.shouldRefine = node.hasChildren && (projectedSize > 20 || isClose || node.level < 4);
            
            // ALWAYS try to recurse to children for close-up or low-level nodes
            const shouldRecurse = node.hasChildren && (node.shouldRefine || node.level < 5 || isClose);
            
            if (shouldRecurse) {
                let actualChildCount = 0;
                for (let i = 0; i < 8; i++) {
                    const child = node.children[i];
                    if (child) {
                        actualChildCount++;
                        this._collectCandidates(child, camera, screenSize, candidates, depth + 1);
                    }
                }
                
                // Critical debug: hasChildren is true but no children found
                if (actualChildCount === 0 && node.hasChildren && shouldLog) {
                    console.error(`[Collect] PROBLEM: ${node.name} hasChildren=true but children array has 0 children!`);
                    console.log(`[Collect] children array:`, node.children);
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
            const nodesToRemove = [];
            for (const node of this.visibleNodes) {
                if (!finalVisibleNodes.has(node)) {
                    nodesToRemove.push(node);
                }
            }
            
            for (const node of nodesToRemove) {
                this._removeNodeFromScene(node);
            }
            
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

        _logDebugStats(candidates = []) {
            const camera = this.extension.viewer.impl.camera;
            
            console.log('[Potree2Scheduler LOD]', {
                frame: this.frameCount,
                camDist: camera.position.length().toFixed(1),
                candidates: candidates.length,
                selected: this._debugStats.selectedCount,
                visible: this._debugStats.visibleCount,
                loading: this._debugStats.loadingCount,
                points: this._debugStats.totalPoints.toLocaleString(),
                refined: this._debugStats.refinedCount,
                keptParents: this._debugStats.keptParentsCount,
                unloaded: this._debugStats.unloadedCount
            });
            
            // Log first few candidates for debugging
            if (candidates.length > 0 && candidates.length < 10) {
                console.log('  Candidates:', candidates.map(c => ({
                    name: c.node.name,
                    level: c.level,
                    screenSize: c.screenSize?.toFixed(0),
                    loaded: c.node.loaded,
                    hasChildren: c.node.hasChildren
                })));
            }
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

        /**
         * Set point budget for all Potree 2.0 clouds
         * @param {number} budget
         */
        setPointBudget(budget) {
            POTREE2_CONFIG.POINT_BUDGET = budget;
            log(`Potree 2.0 point budget set to: ${budget.toLocaleString()}`);
        }

        /**
         * Set refinement threshold for all Potree 2.0 clouds
         * @param {number} threshold
         */
        setRefinementThreshold(threshold) {
            POTREE2_CONFIG.REFINEMENT_THRESHOLD = threshold;
            log(`Potree 2.0 refinement threshold set to: ${threshold}px`);
        }

        /**
         * Enable/disable LOD debug logging
         * @param {boolean} enabled
         */
        setLODDebug(enabled) {
            POTREE2_CONFIG.DEBUG_LOD = enabled;
            log(`Potree 2.0 LOD debug logging: ${enabled}`);
        }

        /**
         * Get current LOD configuration
         * @returns {Object}
         */
        getLODConfig() {
            return {
                pointBudget: POTREE2_CONFIG.POINT_BUDGET,
                refinementThreshold: POTREE2_CONFIG.REFINEMENT_THRESHOLD,
                minNodePixelSize: POTREE2_CONFIG.MIN_NODE_PIXEL_SIZE,
                maxConcurrentLoads: POTREE2_CONFIG.MAX_CONCURRENT_LOADS,
                updateInterval: POTREE2_CONFIG.UPDATE_INTERVAL,
                debugLOD: POTREE2_CONFIG.DEBUG_LOD
            };
        }
    }

    window.Potree2Loader = Potree2Loader;
    window.Potree2PointCloud = Potree2PointCloud;
    window.Potree2Node = Potree2Node;
    window.Potree2Scheduler = Potree2Scheduler;
    window.POTREE2_CONFIG = POTREE2_CONFIG;

    log('Potree2Loader registered');
    log('DEBUG: Use window.POTREE2_CONFIG to view/modify Potree 2.0 config');

})();
