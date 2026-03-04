/**
 * ClashDepthHelper
 * 
 * Alternative implementation for depth-based clash detection that works
 * more directly with Forge Viewer's internal rendering pipeline.
 * 
 * This helper provides a simpler approach using the viewer's existing
 * depth buffer and post-processing capabilities.
 * 
 * @author Generated for BIM + Point Cloud Clash Detection
 * @version 1.0.0
 */

(function() {
    'use strict';

    // ========================================================================
    // CLASH DEPTH HELPER - Simplified Approach
    // ========================================================================

    /**
     * This class provides an alternative method for clash detection
     * by modifying point colors based on their depth relative to the BIM model.
     * 
     * Instead of complex render target management, this approach:
     * 1. Uses the viewer's existing depth buffer via readRenderBuffer
     * 2. Performs CPU-based depth comparison (simpler but slower for large clouds)
     * 3. Modifies point colors directly in the geometry
     */
    class ClashDepthHelper {
        constructor(viewer, potreeExtension) {
            this.viewer = viewer;
            this.potreeExt = potreeExtension;
            this.enabled = false;
            
            // Configuration
            this.config = {
                epsilon: 0.5,           // World units tolerance
                clashColor: [1, 0, 0],  // Red
                nearClashColor: [1, 0.5, 0], // Orange
                sampleRate: 1.0,        // 1.0 = check all points, 0.5 = check 50%
                updateInterval: 100,    // ms between updates
                debugMode: false
            };
            
            // State
            this.lastUpdateTime = 0;
            this.clashPoints = new Set();
            this.originalColors = new Map();
            
            // Bound handlers
            this._updateBound = this._update.bind(this);
            this._intervalId = null;
        }

        /**
         * Enable clash detection
         */
        enable() {
            if (this.enabled) return;
            
            this.enabled = true;
            
            // Start update loop
            this._intervalId = setInterval(this._updateBound, this.config.updateInterval);
            
            console.log('[ClashHelper] Enabled');
        }

        /**
         * Disable clash detection
         */
        disable() {
            if (!this.enabled) return;
            
            this.enabled = false;
            
            // Stop update loop
            if (this._intervalId) {
                clearInterval(this._intervalId);
                this._intervalId = null;
            }
            
            // Restore original colors
            this._restoreColors();
            
            console.log('[ClashHelper] Disabled');
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
         * Set epsilon (depth tolerance in world units)
         */
        setEpsilon(value) {
            this.config.epsilon = Math.max(0.01, value);
            console.log('[ClashHelper] Epsilon:', this.config.epsilon);
        }

        /**
         * Update clash detection
         */
        _update() {
            if (!this.enabled) return;
            if (!this.potreeExt) return;
            
            const now = performance.now();
            if (now - this.lastUpdateTime < this.config.updateInterval) return;
            this.lastUpdateTime = now;
            
            this._performClashDetection();
        }

        /**
         * Perform clash detection using raycasting
         */
        _performClashDetection() {
            const viewer = this.viewer;
            const camera = viewer.impl.camera;
            
            // Get all visible point cloud nodes
            const allNodes = [];
            
            // Potree 1.x
            for (const scheduler of this.potreeExt.schedulers.values()) {
                for (const node of scheduler.visibleNodes) {
                    if (node.points && node.geometry) {
                        allNodes.push(node);
                    }
                }
            }
            
            // Potree 2.0
            if (this.potreeExt.potree2Loader) {
                // Similar collection for 2.0 nodes
            }
            
            if (allNodes.length === 0) return;
            
            // Sample points and check for clashes
            let clashCount = 0;
            const raycaster = new THREE.Raycaster();
            raycaster.params.PointCloud = { threshold: 0.1 };
            
            for (const node of allNodes) {
                const positions = node.geometry.attributes.position.array;
                const colors = node.geometry.attributes.color?.array;
                
                if (!colors) continue;
                
                const numPoints = positions.length / 3;
                const step = Math.ceil(1 / this.config.sampleRate);
                
                for (let i = 0; i < numPoints; i += step) {
                    const idx = i * 3;
                    
                    // Get world position of point
                    const worldPos = new THREE.Vector3(
                        positions[idx],
                        positions[idx + 1],
                        positions[idx + 2]
                    );
                    
                    // Apply cloud transform
                    if (node.cloud && node.cloud.matrixWorld) {
                        worldPos.applyMatrix4(node.cloud.matrixWorld);
                    }
                    
                    // Check if this point intersects with BIM
                    const isClash = this._checkPointClash(worldPos, camera);
                    
                    if (isClash) {
                        // Store original color
                        const key = `${node.name}_${i}`;
                        if (!this.originalColors.has(key)) {
                            this.originalColors.set(key, {
                                r: colors[idx],
                                g: colors[idx + 1],
                                b: colors[idx + 2]
                            });
                        }
                        
                        // Set clash color
                        colors[idx] = this.config.clashColor[0];
                        colors[idx + 1] = this.config.clashColor[1];
                        colors[idx + 2] = this.config.clashColor[2];
                        
                        clashCount++;
                    }
                }
                
                // Mark color attribute for update
                if (node.geometry.attributes.color) {
                    node.geometry.attributes.color.needsUpdate = true;
                }
            }
            
            if (this.config.debugMode && clashCount > 0) {
                console.log('[ClashHelper] Detected clashes:', clashCount);
            }
            
            this.viewer.impl.invalidate(true);
        }

        /**
         * Check if a point clashes with BIM geometry
         */
        _checkPointClash(worldPos, camera) {
            // Use hitTest to check if there's BIM geometry at this position
            const screenPos = worldPos.clone().project(camera);
            
            // Convert to screen coordinates
            const canvas = this.viewer.impl.canvas;
            const x = (screenPos.x + 1) / 2 * canvas.clientWidth;
            const y = (-screenPos.y + 1) / 2 * canvas.clientHeight;
            
            // Check bounds
            if (x < 0 || x > canvas.clientWidth || y < 0 || y > canvas.clientHeight) {
                return false;
            }
            
            // Use viewer's hitTest
            const hitResult = this.viewer.impl.hitTest(x, y, false);
            
            if (hitResult) {
                // Calculate distance from point to hit
                const hitDistance = hitResult.distance;
                const pointDistance = worldPos.distanceTo(camera.position);
                
                // Check if point is at similar depth as BIM surface
                const depthDiff = Math.abs(pointDistance - hitDistance);
                
                return depthDiff < this.config.epsilon;
            }
            
            return false;
        }

        /**
         * Restore original colors
         */
        _restoreColors() {
            for (const scheduler of this.potreeExt.schedulers.values()) {
                for (const node of scheduler.visibleNodes) {
                    if (node.geometry?.attributes.color) {
                        const colors = node.geometry.attributes.color.array;
                        
                        for (const [key, original] of this.originalColors.entries()) {
                            if (key.startsWith(node.name + '_')) {
                                const idx = parseInt(key.split('_')[1]) * 3;
                                if (idx < colors.length - 2) {
                                    colors[idx] = original.r;
                                    colors[idx + 1] = original.g;
                                    colors[idx + 2] = original.b;
                                }
                            }
                        }
                        
                        node.geometry.attributes.color.needsUpdate = true;
                    }
                }
            }
            
            this.originalColors.clear();
            this.viewer.impl.invalidate(true);
        }

        /**
         * Dispose
         */
        dispose() {
            this.disable();
            this.originalColors.clear();
        }
    }

    // ========================================================================
    // GPU-BASED CLASH DETECTOR - More efficient approach
    // ========================================================================

    /**
     * GPU-based clash detection using WebGL depth comparison.
     * This is more efficient than CPU-based approach for large point clouds.
     */
    class GPUClashDetector {
        constructor(viewer) {
            this.viewer = viewer;
            this.impl = viewer.impl;
            this.gl = null;
            this.enabled = false;
            
            // Shaders
            this.clashProgram = null;
            
            // Render targets
            this.depthFramebuffer = null;
            this.depthTexture = null;
            
            // Config
            this.epsilon = 0.001; // NDC epsilon
            this.clashColor = [1.0, 0.0, 0.0];
            
            this._init();
        }

        _init() {
            try {
                this.gl = this.impl.renderer().getContext();
                console.log('[GPUClash] WebGL context acquired');
                
                // Create framebuffer for depth capture
                this._createDepthFramebuffer();
                
            } catch (err) {
                console.error('[GPUClash] Failed to initialize:', err);
            }
        }

        _createDepthFramebuffer() {
            const gl = this.gl;
            const canvas = this.impl.canvas;
            const width = canvas.width;
            const height = canvas.height;
            
            // Create framebuffer
            this.depthFramebuffer = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthFramebuffer);
            
            // Create color texture (for depth encoding)
            this.depthTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
            gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA,
                width, height, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, null
            );
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            
            // Attach texture
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0,
                gl.TEXTURE_2D,
                this.depthTexture,
                0
            );
            
            // Create depth renderbuffer
            const depthBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
            gl.framebufferRenderbuffer(
                gl.FRAMEBUFFER,
                gl.DEPTH_ATTACHMENT,
                gl.RENDERBUFFER,
                depthBuffer
            );
            
            // Check framebuffer completeness
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                console.error('[GPUClash] Framebuffer incomplete:', status);
            } else {
                console.log('[GPUClash] Depth framebuffer created:', width, 'x', height);
            }
            
            // Unbind
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }

        /**
         * Capture BIM depth
         */
        captureDepth() {
            // This would require rendering the BIM scene to our framebuffer
            // with a depth-encoding shader. Complex to implement properly
            // with Forge's internal renderer.
        }

        dispose() {
            const gl = this.gl;
            if (!gl) return;
            
            if (this.depthFramebuffer) {
                gl.deleteFramebuffer(this.depthFramebuffer);
            }
            if (this.depthTexture) {
                gl.deleteTexture(this.depthTexture);
            }
        }
    }

    // ========================================================================
    // SHADER INJECTION HELPER
    // ========================================================================

    /**
     * Helper to inject custom shader code into existing materials.
     * This allows modifying point cloud rendering without replacing materials.
     */
    class ShaderInjector {
        constructor() {
            this.originalShaders = new Map();
        }

        /**
         * Inject clash detection code into a PointsMaterial
         */
        injectClashShader(material, depthTexture, config) {
            if (!(material instanceof THREE.PointsMaterial) && 
                !(material instanceof THREE.ShaderMaterial)) {
                console.warn('[ShaderInjector] Unsupported material type');
                return material;
            }

            // For PointsMaterial, we need to convert to ShaderMaterial
            if (material instanceof THREE.PointsMaterial) {
                return this._convertToClashMaterial(material, depthTexture, config);
            }

            return material;
        }

        _convertToClashMaterial(pointsMaterial, depthTexture, config) {
            const clashMaterial = new THREE.ShaderMaterial({
                vertexShader: `
                    attribute vec3 color;
                    varying vec3 vColor;
                    varying vec2 vScreenUV;
                    
                    void main() {
                        vColor = color;
                        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                        vec4 clipPos = projectionMatrix * mvPosition;
                        gl_Position = clipPos;
                        vScreenUV = (clipPos.xy / clipPos.w) * 0.5 + 0.5;
                        gl_PointSize = ${pointsMaterial.size.toFixed(1)};
                    }
                `,
                fragmentShader: `
                    precision highp float;
                    
                    uniform sampler2D uDepthTex;
                    uniform float uEpsilon;
                    uniform vec3 uClashColor;
                    uniform bool uEnabled;
                    
                    varying vec3 vColor;
                    varying vec2 vScreenUV;
                    
                    void main() {
                        if (!uEnabled) {
                            gl_FragColor = vec4(vColor, 1.0);
                            return;
                        }
                        
                        vec4 depthSample = texture2D(uDepthTex, vScreenUV);
                        float bimDepth = depthSample.r;
                        float pointDepth = gl_FragCoord.z;
                        
                        vec3 finalColor = vColor;
                        if (abs(bimDepth - pointDepth) < uEpsilon) {
                            finalColor = uClashColor;
                        }
                        
                        gl_FragColor = vec4(finalColor, 1.0);
                    }
                `,
                uniforms: {
                    uDepthTex: { type: 't', value: depthTexture },
                    uEpsilon: { type: 'f', value: config.epsilon || 0.001 },
                    uClashColor: { type: 'v3', value: new THREE.Vector3(1, 0, 0) },
                    uEnabled: { type: 'i', value: 1 }
                },
                vertexColors: true,
                depthTest: true,
                depthWrite: true
            });

            return clashMaterial;
        }
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================

    window.ClashDepthHelper = ClashDepthHelper;
    window.GPUClashDetector = GPUClashDetector;
    window.ShaderInjector = ShaderInjector;

    console.log('[ClashDepthHelper] Module loaded');
    console.log('Available classes: ClashDepthHelper, GPUClashDetector, ShaderInjector');

})();


// ============================================================================
// USAGE - ClashDepthHelper (CPU-based, simpler)
// ============================================================================
/*

// Get extensions
const potreeExt = viewer.getExtension('ForgePotreePointCloudExtension');

// Create helper
const clashHelper = new ClashDepthHelper(viewer, potreeExt);

// Configure
clashHelper.config.epsilon = 0.5;  // World units
clashHelper.config.clashColor = [1, 0, 0];  // Red
clashHelper.config.updateInterval = 200;  // ms

// Enable
clashHelper.enable();

// Toggle
clashHelper.toggle();

// Disable
clashHelper.disable();

*/
