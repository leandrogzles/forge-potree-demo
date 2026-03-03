const path = require('path');
const express = require('express');
const config = require('./config.js');
const lasUploadController = require('./services/lasUploadController');

let app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    if (req.path.startsWith('/api/las/upload')) {
        req.setTimeout(30 * 60 * 1000); // 30 minutes for upload
        res.setTimeout(30 * 60 * 1000);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/datasets', express.static(path.join(__dirname, 'public', 'datasets')));

app.use('/api/auth', require('./routes/api/auth'));
app.use('/api/data', require('./routes/api/data'));
app.use('/api/las', require('./routes/api/las'));

async function startServer() {
    try {
        await lasUploadController.initialize();
        console.log('[Server] LAS upload controller initialized');
        
        const health = await lasUploadController.checkHealth();
        console.log('[Server] System health:', health);
        
        if (!health.converterAvailable) {
            console.warn('[Server] WARNING: PotreeConverter not found in PATH!');
            console.warn('[Server] Set POTREE_CONVERTER_PATH environment variable or install PotreeConverter.');
        }
        
        app.listen(config.port, () => {
            console.log(`Server listening on port ${config.port}...`);
            console.log(`http://localhost:${config.port}/`);
            console.log(`http://localhost:${config.port}/forge-potree-native.html`);
            console.log(`\nLAS Upload API:`);
            console.log(`  POST http://localhost:${config.port}/api/las/upload`);
            console.log(`  GET  http://localhost:${config.port}/api/las/datasets`);
            console.log(`  GET  http://localhost:${config.port}/api/las/health`);
        });
    } catch (error) {
        console.error('[Server] Failed to start:', error);
        process.exit(1);
    }
}

startServer();
