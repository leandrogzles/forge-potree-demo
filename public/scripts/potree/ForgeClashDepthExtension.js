/**
 * ForgeClashDepthExtension v2
 * 
 * Visual depth-based clash detection between BIM model (Forge Viewer) and 
 * Point Cloud (THREE.Points in overlay scene).
 * 
 * This version uses a hybrid CPU/GPU approach that is more compatible
 * with Forge Viewer's internal rendering pipeline.
 * 
 * @author Generated for BIM + Point Cloud Clash Detection
 * @version 2.0.0
 */

(function() {
    'use strict';

    // ========================================================================
    // CONFIGURATION
    // ========================================================================
    
    const CLASH_CONFIG = {
        EPSILON: 2.0,                // World units tolerance for clash detection
        CLASH_COLOR: [1.0, 0.0, 0.0],  // Red for clash
        NEAR_CLASH_COLOR: [1.0, 0.5, 0.0], // Orange for near-clash
        INTENSITY: 1.0,              // Clash highlight intensity (blend factor)
        DEBUG: true,                 // Enable debug logging
        UPDATE_INTERVAL: 100,        // ms between updates (0 = continuous)
        SAMPLE_RATE: 0.1,            // Fraction of points to check (0.1 = 10%)
        MAX_POINTS_PER_FRAME: 50000, // Max points to process per frame
        NEAR_MULTIPLIER: 2.0,        // Multiplier for "near clash" threshold
        USE_HITTEST: true,           // Use viewer's hitTest for depth comparison
        BATCH_SIZE: 5000             // Points to process per batch
    };

    function log(...args) {
        if (CLASH_CONFIG.DEBUG) {
            console.log('[ClashDepth]', ...args);
        }
    }

    function warn(...args) {
        console.warn('[ClashDepth]', ...args);
    }

    function error(...args) {
        console.error('[ClashDepth]', ...args);
    }

    // ========================================================================
    // CLASH DETECTOR - Core detection logic
    // ========================================================================

    class ClashDetector {
        constructor(viewer, potreeExtension) {
            this.viewer = viewer;
            this.impl = viewer.impl;
            this.potreeExt = potreeExtension;
            
            // State
            this.enabled = false;
            this.processing = false;
            this.lastUpdateTime = 0;
            
            // Storage for original colors
            this.originalColors = new Map(); // nodeId -> Float32Array
            this.clashResults = new Map();   // nodeId -> Set of clash indices
            
            // Statistics
            this.stats = {
                totalPointsChecked: 0,
                clashPointsFound: 0,
                nearClashPointsFound: 0,
                lastProcessingTime: 0
            };
            
            // Processing queue
            this.processQueue = [];
            this.currentBatchIndex = 0;
            
            log('ClashDetector created');
        }

        /**
         * Enable clash detection
         */
        enable() {
            if (this.enabled) return;
            
            this.enabled = true;
            log('Clash detection ENABLED');
            log('Config:', {
                epsilon: CLASH_CONFIG.EPSILON,
                sampleRate: CLASH_CONFIG.SAMPLE_RATE,
                maxPointsPerFrame: CLASH_CONFIG.MAX_POINTS_PER_FRAME
            });
            
            // Start processing
            this._scheduleUpdate();
        }

        /**
         * Disable clash detection
         */
        disable() {
            if (!this.enabled) return;
            
            this.enabled = false;
            this.processing = false;
            
            // Restore original colors
            this._restoreAllColors();
            
            // Clear state
            this.clashResults.clear();
            this.stats = {
                totalPointsChecked: 0,
                clashPointsFound: 0,
                nearClashPointsFound: 0,
                lastProcessingTime: 0
            };
            
            log('Clash detection DISABLED');
        }

        /**
         * Toggle clash detection
         */
        toggle() {
            if (this.enabled) {
                this.disable();
            } else {
                this.enable();
            }
            return this.enabled;
        }

        /**
         * Force a full update
         */
        refresh() {
            if (!this.enabled) return;
            
            log('Forcing clash detection refresh...');
            
            // Clear previous results
            this._restoreAllColors();
            this.clashResults.clear();
            
            // Re-process
            this._performClashDetection();
        }

        /**
         * Schedule next update
         */
        _scheduleUpdate() {
            if (!this.enabled) return;
            
            const now = performance.now();
            const elapsed = now - this.lastUpdateTime;
            
            if (elapsed >= CLASH_CONFIG.UPDATE_INTERVAL) {
                this._performClashDetection();
                this.lastUpdateTime = now;
            }
            
            // Schedule next frame
            requestAnimationFrame(() => this._scheduleUpdate());
        }

        /**
         * Main clash detection routine
         */
        _performClashDetection() {
            if (!this.enabled || this.processing) return;
            if (!this.potreeExt) {
                this.potreeExt = this.viewer.getExtension('ForgePotreePointCloudExtension');
                if (!this.potreeExt) {
                    warn('Potree extension not found');
                    return;
                }
            }
            
            this.processing = true;
            const startTime = performance.now();
            
            // Collect all visible point cloud nodes
            const nodes = this._collectVisibleNodes();
            
            if (nodes.length === 0) {
                this.processing = false;
                return;
            }
            
            log(`Processing ${nodes.length} nodes for clash detection...`);
            
            let totalClashes = 0;
            let totalNearClashes = 0;
            let totalChecked = 0;
            
            const camera = this.impl.camera;
            const canvas = this.impl.canvas;
            const canvasWidth = canvas.clientWidth;
            const canvasHeight = canvas.clientHeight;
            
            for (const node of nodes) {
                if (!node.geometry || !node.geometry.attributes.position) continue;
                
                const positions = node.geometry.attributes.position.array;
                const numPoints = positions.length / 3;
                
                // Ensure we have color attribute
                let colors = node.geometry.attributes.color?.array;
                if (!colors) {
                    log(`Node ${node.name} has no color attribute, skipping`);
                    continue;
                }
                
                // Store original colors if not already stored
                const nodeKey = node.name || node.uuid;
                if (!this.originalColors.has(nodeKey)) {
                    this.originalColors.set(nodeKey, new Float32Array(colors));
                    log(`Stored original colors for node ${nodeKey}: ${numPoints} points`);
                }
                
                const originalColors = this.originalColors.get(nodeKey);
                
                // Get cloud transform matrix
                const matrixWorld = node.cloud?.matrixWorld || new THREE.Matrix4();
                
                // Sample points based on sample rate
                const step = Math.max(1, Math.floor(1 / CLASH_CONFIG.SAMPLE_RATE));
                const maxToCheck = Math.min(numPoints, CLASH_CONFIG.MAX_POINTS_PER_FRAME);
                
                let nodeClashes = 0;
                let nodeNearClashes = 0;
                
                for (let i = 0; i < maxToCheck; i += step) {
                    const idx = i * 3;
                    
                    // Get point world position
                    const worldPos = new THREE.Vector3(
                        positions[idx],
                        positions[idx + 1],
                        positions[idx + 2]
                    );
                    worldPos.applyMatrix4(matrixWorld);
                    
                    // Check clash using hitTest
                    const clashResult = this._checkPointClash(worldPos, camera, canvasWidth, canvasHeight);
                    
                    totalChecked++;
                    
                    if (clashResult === 'clash') {
                        // Direct clash - paint red
                        colors[idx] = CLASH_CONFIG.CLASH_COLOR[0] * CLASH_CONFIG.INTENSITY + 
                                     originalColors[idx] * (1 - CLASH_CONFIG.INTENSITY);
                        colors[idx + 1] = CLASH_CONFIG.CLASH_COLOR[1] * CLASH_CONFIG.INTENSITY + 
                                         originalColors[idx + 1] * (1 - CLASH_CONFIG.INTENSITY);
                        colors[idx + 2] = CLASH_CONFIG.CLASH_COLOR[2] * CLASH_CONFIG.INTENSITY + 
                                         originalColors[idx + 2] * (1 - CLASH_CONFIG.INTENSITY);
                        nodeClashes++;
                        totalClashes++;
                    } else if (clashResult === 'near') {
                        // Near clash - paint orange
                        colors[idx] = CLASH_CONFIG.NEAR_CLASH_COLOR[0] * CLASH_CONFIG.INTENSITY * 0.5 + 
                                     originalColors[idx] * (1 - CLASH_CONFIG.INTENSITY * 0.5);
                        colors[idx + 1] = CLASH_CONFIG.NEAR_CLASH_COLOR[1] * CLASH_CONFIG.INTENSITY * 0.5 + 
                                         originalColors[idx + 1] * (1 - CLASH_CONFIG.INTENSITY * 0.5);
                        colors[idx + 2] = CLASH_CONFIG.NEAR_CLASH_COLOR[2] * CLASH_CONFIG.INTENSITY * 0.5 + 
                                         originalColors[idx + 2] * (1 - CLASH_CONFIG.INTENSITY * 0.5);
                        nodeNearClashes++;
                        totalNearClashes++;
                    } else {
                        // No clash - restore original color
                        colors[idx] = originalColors[idx];
                        colors[idx + 1] = originalColors[idx + 1];
                        colors[idx + 2] = originalColors[idx + 2];
                    }
                }
                
                // Mark color buffer for update
                node.geometry.attributes.color.needsUpdate = true;
                
                if (nodeClashes > 0 || nodeNearClashes > 0) {
                    log(`Node ${nodeKey}: ${nodeClashes} clashes, ${nodeNearClashes} near-clashes`);
                }
            }
            
            // Update stats
            const processingTime = performance.now() - startTime;
            this.stats = {
                totalPointsChecked: totalChecked,
                clashPointsFound: totalClashes,
                nearClashPointsFound: totalNearClashes,
                lastProcessingTime: processingTime
            };
            
            if (totalClashes > 0 || totalNearClashes > 0) {
                log(`Clash detection complete: ${totalClashes} clashes, ${totalNearClashes} near-clashes (${processingTime.toFixed(1)}ms)`);
            }
            
            // Invalidate viewer to show changes
            this.impl.invalidate(true, true, true);
            
            this.processing = false;
        }

        /**
         * Check if a single point clashes with BIM geometry
         */
        _checkPointClash(worldPos, camera, canvasWidth, canvasHeight) {
            // Project point to screen coordinates
            const screenPos = worldPos.clone().project(camera);
            
            // Convert to pixel coordinates
            const x = (screenPos.x + 1) / 2 * canvasWidth;
            const y = (-screenPos.y + 1) / 2 * canvasHeight;
            
            // Check if on screen
            if (x < 0 || x >= canvasWidth || y < 0 || y >= canvasHeight) {
                return 'none';
            }
            
            // Check if point is behind camera
            if (screenPos.z > 1 || screenPos.z < -1) {
                return 'none';
            }
            
            // Use viewer's hitTest to find BIM geometry at this screen position
            const hitResult = this.impl.hitTest(x, y, false);
            
            if (!hitResult) {
                // No BIM geometry at this position
                return 'none';
            }
            
            // Calculate distances
            const pointDistance = camera.position.distanceTo(worldPos);
            const bimDistance = hitResult.distance;
            
            // Compare depths
            const depthDiff = Math.abs(pointDistance - bimDistance);
            
            if (depthDiff <= CLASH_CONFIG.EPSILON) {
                // Point is at same depth as BIM surface (within tolerance)
                return 'clash';
            } else if (depthDiff <= CLASH_CONFIG.EPSILON * CLASH_CONFIG.NEAR_MULTIPLIER) {
                // Point is near BIM surface
                return 'near';
            } else if (pointDistance < bimDistance) {
                // Point is in front of BIM - could be occluding
                // Check if very close to BIM surface
                if (bimDistance - pointDistance < CLASH_CONFIG.EPSILON * 3) {
                    return 'near';
                }
            }
            
            return 'none';
        }

        /**
         * Collect all visible point cloud nodes
         */
        _collectVisibleNodes() {
            const nodes = [];
            
            if (!this.potreeExt) return nodes;
            
            // Potree 1.x nodes
            for (const scheduler of this.potreeExt.schedulers.values()) {
                for (const node of scheduler.visibleNodes) {
                    if (node.points && node.geometry) {
                        nodes.push(node);
                    }
                }
            }
            
            // Potree 2.0 nodes
            if (this.potreeExt.potree2Loader) {
                const p2Schedulers = this.potreeExt.potree2Loader.schedulers;
                if (p2Schedulers) {
                    for (const scheduler of p2Schedulers.values()) {
                        for (const node of scheduler.visibleNodes) {
                            if (node.points && node.geometry) {
                                nodes.push(node);
                            }
                        }
                    }
                }
            }
            
            return nodes;
        }

        /**
         * Restore original colors for all nodes
         */
        _restoreAllColors() {
            log('Restoring original colors...');
            
            const nodes = this._collectVisibleNodes();
            
            for (const node of nodes) {
                const nodeKey = node.name || node.uuid;
                const originalColors = this.originalColors.get(nodeKey);
                
                if (originalColors && node.geometry?.attributes.color) {
                    const colors = node.geometry.attributes.color.array;
                    
                    // Copy original colors back
                    for (let i = 0; i < originalColors.length && i < colors.length; i++) {
                        colors[i] = originalColors[i];
                    }
                    
                    node.geometry.attributes.color.needsUpdate = true;
                }
            }
            
            this.originalColors.clear();
            this.impl.invalidate(true, true, true);
            
            log('Original colors restored');
        }

        /**
         * Get current statistics
         */
        getStats() {
            return { ...this.stats };
        }

        /**
         * Dispose resources
         */
        dispose() {
            this.disable();
            this.originalColors.clear();
            this.clashResults.clear();
        }
    }

    // ========================================================================
    // FORGE CLASH DEPTH EXTENSION
    // ========================================================================

    class ForgeClashDepthExtension extends Autodesk.Viewing.Extension {
        constructor(viewer, options) {
            super(viewer, options);
            
            this.clashDetector = null;
            this.potreeExtension = null;
            this.enabled = false;
            
            // Bound event handlers
            this._onCameraChangeBound = this._onCameraChange.bind(this);
        }

        load() {
            log('Loading ForgeClashDepthExtension v2...');
            
            // Get Potree extension
            this.potreeExtension = this.viewer.getExtension('ForgePotreePointCloudExtension');
            
            // Create clash detector
            this.clashDetector = new ClashDetector(this.viewer, this.potreeExtension);
            
            // Listen for camera changes to re-detect
            this.viewer.addEventListener(
                Autodesk.Viewing.CAMERA_CHANGE_EVENT,
                this._onCameraChangeBound
            );
            
            log('ForgeClashDepthExtension v2 loaded successfully');
            log('API: clashExt.enable(), clashExt.disable(), clashExt.setEpsilon(value)');
            
            return true;
        }

        unload() {
            log('Unloading ForgeClashDepthExtension...');
            
            // Remove event listener
            this.viewer.removeEventListener(
                Autodesk.Viewing.CAMERA_CHANGE_EVENT,
                this._onCameraChangeBound
            );
            
            // Dispose detector
            if (this.clashDetector) {
                this.clashDetector.dispose();
                this.clashDetector = null;
            }
            
            log('ForgeClashDepthExtension unloaded');
            return true;
        }

        // ====================================================================
        // EVENT HANDLERS
        // ====================================================================

        _onCameraChange() {
            // Camera changed - clash detection will update on next cycle
            // The detector has its own update loop
        }

        // ====================================================================
        // PUBLIC API
        // ====================================================================

        /**
         * Enable clash detection
         */
        enable() {
            // Ensure we have Potree extension reference
            if (!this.potreeExtension) {
                this.potreeExtension = this.viewer.getExtension('ForgePotreePointCloudExtension');
            }
            
            if (!this.potreeExtension) {
                error('ForgePotreePointCloudExtension not loaded - cannot enable clash detection');
                return false;
            }
            
            // Update detector's reference
            this.clashDetector.potreeExt = this.potreeExtension;
            
            this.enabled = true;
            this.clashDetector.enable();
            
            return true;
        }

        /**
         * Disable clash detection
         */
        disable() {
            this.enabled = false;
            this.clashDetector.disable();
        }

        /**
         * Toggle clash detection
         * @returns {boolean} New state
         */
        toggle() {
            if (this.enabled) {
                this.disable();
            } else {
                this.enable();
            }
            return this.enabled;
        }

        /**
         * Set epsilon (depth tolerance in world units)
         * @param {number} value - Tolerance value
         */
        setEpsilon(value) {
            CLASH_CONFIG.EPSILON = Math.max(0.1, value);
            log('Epsilon set to:', CLASH_CONFIG.EPSILON, 'world units');
            
            // Refresh detection with new epsilon
            if (this.enabled) {
                this.refresh();
            }
        }

        /**
         * Get current epsilon
         * @returns {number}
         */
        getEpsilon() {
            return CLASH_CONFIG.EPSILON;
        }

        /**
         * Set clash highlight color
         * @param {number} r - Red (0-1)
         * @param {number} g - Green (0-1)
         * @param {number} b - Blue (0-1)
         */
        setClashColor(r, g, b) {
            CLASH_CONFIG.CLASH_COLOR = [r, g, b];
            log('Clash color set to:', r, g, b);
            
            if (this.enabled) {
                this.refresh();
            }
        }

        /**
         * Set clash highlight intensity
         * @param {number} value - Intensity (0-1)
         */
        setIntensity(value) {
            CLASH_CONFIG.INTENSITY = Math.max(0, Math.min(1, value));
            log('Intensity set to:', CLASH_CONFIG.INTENSITY);
            
            if (this.enabled) {
                this.refresh();
            }
        }

        /**
         * Set sample rate (fraction of points to check)
         * @param {number} value - Sample rate (0.01 to 1.0)
         */
        setSampleRate(value) {
            CLASH_CONFIG.SAMPLE_RATE = Math.max(0.01, Math.min(1.0, value));
            log('Sample rate set to:', CLASH_CONFIG.SAMPLE_RATE);
        }

        /**
         * Set debug mode
         * @param {boolean} enabled
         */
        setDebugDepth(enabled) {
            CLASH_CONFIG.DEBUG = enabled;
            log('Debug mode:', enabled ? 'ON' : 'OFF');
        }

        /**
         * Force refresh clash detection
         */
        refresh() {
            if (this.clashDetector) {
                this.clashDetector.refresh();
            }
        }

        /**
         * Get current configuration
         * @returns {Object}
         */
        getConfig() {
            return {
                enabled: this.enabled,
                epsilon: CLASH_CONFIG.EPSILON,
                clashColor: CLASH_CONFIG.CLASH_COLOR,
                intensity: CLASH_CONFIG.INTENSITY,
                sampleRate: CLASH_CONFIG.SAMPLE_RATE,
                debug: CLASH_CONFIG.DEBUG
            };
        }

        /**
         * Get statistics
         * @returns {Object}
         */
        getStats() {
            if (this.clashDetector) {
                return this.clashDetector.getStats();
            }
            return {
                totalPointsChecked: 0,
                clashPointsFound: 0,
                nearClashPointsFound: 0,
                lastProcessingTime: 0
            };
        }

        /**
         * Debug: print current state
         */
        debugNow() {
            console.log('='.repeat(50));
            console.log('CLASH DEPTH EXTENSION DEBUG');
            console.log('='.repeat(50));
            console.log('Enabled:', this.enabled);
            console.log('Config:', this.getConfig());
            console.log('Stats:', this.getStats());
            console.log('Potree Extension:', this.potreeExtension ? 'Found' : 'NOT FOUND');
            
            if (this.potreeExtension) {
                console.log('Potree Clouds:', this.potreeExtension.clouds.size);
                console.log('Potree Schedulers:', this.potreeExtension.schedulers.size);
                
                let totalNodes = 0;
                for (const scheduler of this.potreeExtension.schedulers.values()) {
                    totalNodes += scheduler.visibleNodes.size;
                }
                console.log('Total Visible Nodes:', totalNodes);
            }
            
            console.log('='.repeat(50));
            return 'Debug complete';
        }
    }

    // ========================================================================
    // REGISTER EXTENSION
    // ========================================================================

    Autodesk.Viewing.theExtensionManager.registerExtension(
        'ForgeClashDepthExtension',
        ForgeClashDepthExtension
    );

    // Export for external access
    window.ForgeClashDepthExtension = ForgeClashDepthExtension;
    window.ClashDetector = ClashDetector;
    window.CLASH_CONFIG = CLASH_CONFIG;

    log('ForgeClashDepthExtension v2 registered');
    log('Commands: clashExt.enable(), clashExt.debugNow(), window.CLASH_CONFIG');

})();


// ============================================================================
// USAGE
// ============================================================================
/*

// After viewer and point cloud are loaded:
const clashExt = viewer.getExtension('ForgeClashDepthExtension');

// Enable clash detection
clashExt.enable();

// Adjust parameters
clashExt.setEpsilon(2.0);        // World units tolerance (larger = more clashes detected)
clashExt.setIntensity(0.8);      // Blend intensity (0-1)
clashExt.setClashColor(1, 0, 0); // RGB (0-1)
clashExt.setSampleRate(0.2);     // Check 20% of points

// Force refresh
clashExt.refresh();

// Get stats
console.log(clashExt.getStats());

// Debug
clashExt.debugNow();

// Disable
clashExt.disable();

// Toggle
clashExt.toggle();

*/
