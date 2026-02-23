const express = require('express');
const config = require('../../config.js');

const { AuthenticationClient, Scopes } = require('@aps_sdk/authentication');

let authenticationClient = new AuthenticationClient();
let router = express.Router();

// GET /api/auth/token
// Generate access token for the viewer (ViewablesRead scope for security)
router.get('/token', async function (req, res, next) {
    try {
        const credentials = await authenticationClient.getTwoLeggedToken(
            config.client_id, 
            config.client_secret, 
            [Scopes.ViewablesRead]
        );
        // Return the full object with access_token and expires_in
        res.json({
            access_token: credentials.access_token,
            expires_in: credentials.expires_in
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;