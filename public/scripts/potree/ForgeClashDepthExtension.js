/**
 * ForgeClashDepthExtension v3
 * 
 * Visual depth-based clash detection between BIM model (Forge Viewer) and 
 * Point Cloud (THREE.Points in overlay scene).
 * 
 * This version uses gradual analysis with progress tracking.
 * Results persist until manually reset by the user.
 * 
 * @author Generated for BIM + Point Cloud Clash Detection
 * @version 3.0.0
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
        SAMPLE_RATE: 0.1,            // Fraction of points to check (0.1 = 10%)
        NEAR_MULTIPLIER: 2.0,        // Multiplier for "near clash" threshold
        USE_HITTEST: true,           // Use viewer's hitTest for depth comparison
        BATCH_SIZE: 2000,            // Points to process per batch (smaller for smoother progress)
        BATCH_DELAY: 10              // ms delay between batches for UI responsiveness
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
    // CLASH DETECTOR - Core detection logic (Gradual Analysis with Progress)
    // ========================================================================

    class ClashDetector {
        constructor(viewer, potreeExtension) {
            this.viewer = viewer;
            this.impl = viewer.impl;
            this.potreeExt = potreeExtension;
            
            // State
            this.analyzing = false;
            this.analysisComplete = false;
            this.abortRequested = false;
            
            // Storage for original colors
            this.originalColors = new Map(); // nodeId -> Float32Array
            this.clashResults = new Map();   // nodeId -> Set of clash indices
            
            // Progress tracking
            this.progress = {
                current: 0,
                total: 0,
                percentage: 0,
                currentNode: '',
                nodesProcessed: 0,
                totalNodes: 0
            };
            
            // Callbacks
            this.onProgressCallback = null;
            this.onCompleteCallback = null;
            
            // Statistics
            this.stats = {
                totalPointsChecked: 0,
                clashPointsFound: 0,
                nearClashPointsFound: 0,
                lastProcessingTime: 0
            };
            
            log('ClashDetector v3 created (Gradual Analysis Mode)');
        }

        /**
         * Set progress callback
         * @param {function} callback - Called with progress object {current, total, percentage, currentNode}
         */
        setProgressCallback(callback) {
            this.onProgressCallback = callback;
        }

        /**
         * Set completion callback
         * @param {function} callback - Called when analysis completes with stats
         */
        setCompleteCallback(callback) {
            this.onCompleteCallback = callback;
        }

        /**
         * Start clash analysis (one-time, not continuous)
         * @returns {Promise} Resolves when analysis completes
         */
        async runAnalysis() {
            if (this.analyzing) {
                warn('Analysis already in progress');
                return;
            }
            
            if (!this.potreeExt) {
                this.potreeExt = this.viewer.getExtension('ForgePotreePointCloudExtension');
                if (!this.potreeExt) {
                    error('Potree extension not found');
                    return;
                }
            }
            
            this.analyzing = true;
            this.analysisComplete = false;
            this.abortRequested = false;
            
            log('Starting clash analysis...');
            log('Config:', {
                epsilon: CLASH_CONFIG.EPSILON,
                sampleRate: CLASH_CONFIG.SAMPLE_RATE,
                batchSize: CLASH_CONFIG.BATCH_SIZE
            });
            
            const startTime = performance.now();
            
            // Reset stats
            this.stats = {
                totalPointsChecked: 0,
                clashPointsFound: 0,
                nearClashPointsFound: 0,
                lastProcessingTime: 0
            };
            
            try {
                await this._performGradualAnalysis();
                
                const processingTime = performance.now() - startTime;
                this.stats.lastProcessingTime = processingTime;
                
                log(`Analysis complete: ${this.stats.clashPointsFound} clashes, ${this.stats.nearClashPointsFound} near-clashes (${processingTime.toFixed(1)}ms)`);
                
                this.analysisComplete = true;
                
                if (this.onCompleteCallback) {
                    this.onCompleteCallback(this.stats);
                }
                
            } catch (err) {
                error('Analysis failed:', err);
            } finally {
                this.analyzing = false;
            }
        }

        /**
         * Abort running analysis
         */
        abortAnalysis() {
            if (this.analyzing) {
                this.abortRequested = true;
                log('Analysis abort requested');
            }
        }

        /**
         * Reset clash colors to original (manual reset only)
         */
        resetColors() {
            log('Resetting clash colors...');
            this._restoreAllColors();
            
            // Reset stats
            this.stats = {
                totalPointsChecked: 0,
                clashPointsFound: 0,
                nearClashPointsFound: 0,
                lastProcessingTime: 0
            };
            
            this.analysisComplete = false;
            
            // Reset progress
            this.progress = {
                current: 0,
                total: 0,
                percentage: 0,
                currentNode: '',
                nodesProcessed: 0,
                totalNodes: 0
            };
            
            if (this.onProgressCallback) {
                this.onProgressCallback(this.progress);
            }
            
            log('Clash colors reset complete');
        }

        /**
         * Perform gradual analysis with batching
         */
        async _performGradualAnalysis() {
            const nodes = this._collectVisibleNodes();
            
            if (nodes.length === 0) {
                log('No visible nodes to analyze');
                return;
            }
            
            // Calculate total points to process
            let totalPoints = 0;
            for (const node of nodes) {
                if (node.geometry?.attributes.position) {
                    const numPoints = node.geometry.attributes.position.array.length / 3;
                    const step = Math.max(1, Math.floor(1 / CLASH_CONFIG.SAMPLE_RATE));
                    totalPoints += Math.ceil(numPoints / step);
                }
            }
            
            this.progress.total = totalPoints;
            this.progress.totalNodes = nodes.length;
            this.progress.current = 0;
            this.progress.nodesProcessed = 0;
            
            log(`Analyzing ${nodes.length} nodes, ~${totalPoints} points to check...`);
            
            const camera = this.impl.camera;
            const canvas = this.impl.canvas;
            const canvasWidth = canvas.clientWidth;
            const canvasHeight = canvas.clientHeight;
            
            // Process each node
            for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
                if (this.abortRequested) {
                    log('Analysis aborted by user');
                    break;
                }
                
                const node = nodes[nodeIndex];
                if (!node.geometry || !node.geometry.attributes.position) continue;
                
                const positions = node.geometry.attributes.position.array;
                const numPoints = positions.length / 3;
                
                let colors = node.geometry.attributes.color?.array;
                if (!colors) {
                    log(`Node ${node.name} has no color attribute, skipping`);
                    continue;
                }
                
                const nodeKey = node.name || node.uuid;
                this.progress.currentNode = nodeKey;
                
                // Store original colors if not already stored
                if (!this.originalColors.has(nodeKey)) {
                    this.originalColors.set(nodeKey, new Float32Array(colors));
                }
                
                const originalColors = this.originalColors.get(nodeKey);
                const matrixWorld = node.cloud?.matrixWorld || new THREE.Matrix4();
                const step = Math.max(1, Math.floor(1 / CLASH_CONFIG.SAMPLE_RATE));
                
                // Process in batches
                let batchCount = 0;
                for (let i = 0; i < numPoints; i += step) {
                    if (this.abortRequested) break;
                    
                    const idx = i * 3;
                    
                    // Get point world position
                    const worldPos = new THREE.Vector3(
                        positions[idx],
                        positions[idx + 1],
                        positions[idx + 2]
                    );
                    worldPos.applyMatrix4(matrixWorld);
                    
                    // Check clash
                    const clashResult = this._checkPointClash(worldPos, camera, canvasWidth, canvasHeight);
                    
                    this.stats.totalPointsChecked++;
                    this.progress.current++;
                    
                    if (clashResult === 'clash') {
                        colors[idx] = CLASH_CONFIG.CLASH_COLOR[0] * CLASH_CONFIG.INTENSITY + 
                                     originalColors[idx] * (1 - CLASH_CONFIG.INTENSITY);
                        colors[idx + 1] = CLASH_CONFIG.CLASH_COLOR[1] * CLASH_CONFIG.INTENSITY + 
                                         originalColors[idx + 1] * (1 - CLASH_CONFIG.INTENSITY);
                        colors[idx + 2] = CLASH_CONFIG.CLASH_COLOR[2] * CLASH_CONFIG.INTENSITY + 
                                         originalColors[idx + 2] * (1 - CLASH_CONFIG.INTENSITY);
                        this.stats.clashPointsFound++;
                    } else if (clashResult === 'near') {
                        colors[idx] = CLASH_CONFIG.NEAR_CLASH_COLOR[0] * CLASH_CONFIG.INTENSITY * 0.5 + 
                                     originalColors[idx] * (1 - CLASH_CONFIG.INTENSITY * 0.5);
                        colors[idx + 1] = CLASH_CONFIG.NEAR_CLASH_COLOR[1] * CLASH_CONFIG.INTENSITY * 0.5 + 
                                         originalColors[idx + 1] * (1 - CLASH_CONFIG.INTENSITY * 0.5);
                        colors[idx + 2] = CLASH_CONFIG.NEAR_CLASH_COLOR[2] * CLASH_CONFIG.INTENSITY * 0.5 + 
                                         originalColors[idx + 2] * (1 - CLASH_CONFIG.INTENSITY * 0.5);
                        this.stats.nearClashPointsFound++;
                    }
                    
                    batchCount++;
                    
                    // Yield to UI after each batch
                    if (batchCount >= CLASH_CONFIG.BATCH_SIZE) {
                        batchCount = 0;
                        
                        // Update progress
                        this.progress.percentage = Math.round((this.progress.current / this.progress.total) * 100);
                        
                        if (this.onProgressCallback) {
                            this.onProgressCallback({ ...this.progress });
                        }
                        
                        // Update colors and invalidate
                        node.geometry.attributes.color.needsUpdate = true;
                        this.impl.invalidate(true, true, true);
                        
                        // Yield to browser
                        await this._delay(CLASH_CONFIG.BATCH_DELAY);
                    }
                }
                
                // Final update for this node
                node.geometry.attributes.color.needsUpdate = true;
                this.progress.nodesProcessed++;
            }
            
            // Final progress update
            this.progress.percentage = 100;
            if (this.onProgressCallback) {
                this.onProgressCallback({ ...this.progress });
            }
            
            this.impl.invalidate(true, true, true);
        }

        /**
         * Delay helper for yielding to UI
         */
        _delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
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
            this.analyzing = false;
        }

        load() {
            log('Loading ForgeClashDepthExtension v3 (Gradual Analysis)...');
            
            // Get Potree extension
            this.potreeExtension = this.viewer.getExtension('ForgePotreePointCloudExtension');
            
            // Create clash detector
            this.clashDetector = new ClashDetector(this.viewer, this.potreeExtension);
            
            log('ForgeClashDepthExtension v3 loaded successfully');
            log('API: clashExt.runAnalysis(), clashExt.resetColors(), clashExt.abortAnalysis()');
            
            return true;
        }

        unload() {
            log('Unloading ForgeClashDepthExtension...');
            
            // Dispose detector
            if (this.clashDetector) {
                this.clashDetector.dispose();
                this.clashDetector = null;
            }
            
            log('ForgeClashDepthExtension unloaded');
            return true;
        }

        // ====================================================================
        // PUBLIC API
        // ====================================================================

        /**
         * Run clash analysis (one-time, not continuous)
         * @returns {Promise} Resolves when analysis completes
         */
        async runAnalysis() {
            // Ensure we have Potree extension reference
            if (!this.potreeExtension) {
                this.potreeExtension = this.viewer.getExtension('ForgePotreePointCloudExtension');
            }
            
            if (!this.potreeExtension) {
                error('ForgePotreePointCloudExtension not loaded - cannot run analysis');
                return false;
            }
            
            // Update detector's reference
            this.clashDetector.potreeExt = this.potreeExtension;
            
            this.analyzing = true;
            
            try {
                await this.clashDetector.runAnalysis();
            } finally {
                this.analyzing = false;
            }
            
            return true;
        }

        /**
         * Abort running analysis
         */
        abortAnalysis() {
            if (this.clashDetector) {
                this.clashDetector.abortAnalysis();
            }
        }

        /**
         * Reset clash colors to original
         */
        resetColors() {
            if (this.clashDetector) {
                this.clashDetector.resetColors();
            }
        }

        /**
         * Check if analysis is running
         * @returns {boolean}
         */
        isAnalyzing() {
            return this.clashDetector?.analyzing || false;
        }

        /**
         * Check if analysis is complete
         * @returns {boolean}
         */
        isAnalysisComplete() {
            return this.clashDetector?.analysisComplete || false;
        }

        /**
         * Set progress callback
         * @param {function} callback - Called with {current, total, percentage, currentNode}
         */
        setProgressCallback(callback) {
            if (this.clashDetector) {
                this.clashDetector.setProgressCallback(callback);
            }
        }

        /**
         * Set completion callback
         * @param {function} callback - Called with stats when analysis completes
         */
        setCompleteCallback(callback) {
            if (this.clashDetector) {
                this.clashDetector.setCompleteCallback(callback);
            }
        }

        /**
         * Get current progress
         * @returns {Object}
         */
        getProgress() {
            if (this.clashDetector) {
                return { ...this.clashDetector.progress };
            }
            return { current: 0, total: 0, percentage: 0 };
        }

        /**
         * Set epsilon (depth tolerance in world units)
         * @param {number} value - Tolerance value
         */
        setEpsilon(value) {
            CLASH_CONFIG.EPSILON = Math.max(0.1, value);
            log('Epsilon set to:', CLASH_CONFIG.EPSILON, 'world units');
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
        }

        /**
         * Set clash highlight intensity
         * @param {number} value - Intensity (0-1)
         */
        setIntensity(value) {
            CLASH_CONFIG.INTENSITY = Math.max(0, Math.min(1, value));
            log('Intensity set to:', CLASH_CONFIG.INTENSITY);
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
         * Get current configuration
         * @returns {Object}
         */
        getConfig() {
            return {
                analyzing: this.analyzing,
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
            console.log('CLASH DEPTH EXTENSION v3 DEBUG');
            console.log('='.repeat(50));
            console.log('Analyzing:', this.analyzing);
            console.log('Analysis Complete:', this.isAnalysisComplete());
            console.log('Config:', this.getConfig());
            console.log('Stats:', this.getStats());
            console.log('Progress:', this.getProgress());
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

        // Legacy API compatibility
        enable() {
            warn('enable() is deprecated. Use runAnalysis() instead.');
            this.runAnalysis();
        }

        disable() {
            warn('disable() is deprecated. Use resetColors() to clear results.');
        }

        refresh() {
            warn('refresh() is deprecated. Use resetColors() then runAnalysis() instead.');
            this.resetColors();
            this.runAnalysis();
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

    log('ForgeClashDepthExtension v3 registered (Gradual Analysis Mode)');
    log('Commands: clashExt.runAnalysis(), clashExt.resetColors(), clashExt.abortAnalysis()');

})();


// ============================================================================
// USAGE - v3 Gradual Analysis Mode
// ============================================================================
/*

// After viewer and point cloud are loaded:
const clashExt = viewer.getExtension('ForgeClashDepthExtension');

// Set up progress callback (for progress bar)
clashExt.setProgressCallback((progress) => {
    console.log(`Progress: ${progress.percentage}% (${progress.current}/${progress.total})`);
    // Update your progress bar UI here
});

// Set up completion callback
clashExt.setCompleteCallback((stats) => {
    console.log('Analysis complete!', stats);
    // Update your UI here
});

// Adjust parameters BEFORE running analysis
clashExt.setEpsilon(2.0);        // World units tolerance (larger = more clashes detected)
clashExt.setIntensity(0.8);      // Blend intensity (0-1)
clashExt.setClashColor(1, 0, 0); // RGB (0-1)
clashExt.setSampleRate(0.2);     // Check 20% of points

// Run analysis (one-time, not continuous)
await clashExt.runAnalysis();

// Check progress during analysis
console.log(clashExt.getProgress());

// Abort if needed
clashExt.abortAnalysis();

// Get stats after analysis
console.log(clashExt.getStats());

// Reset colors to original (manual action required)
clashExt.resetColors();

// Debug
clashExt.debugNow();

*/
