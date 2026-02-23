const express = require('express');
const config = require('../../config.js');

const { AuthenticationClient, Scopes } = require('@aps_sdk/authentication');
const { OssClient, Region, PolicyKey } = require('@aps_sdk/oss');

const authenticationClient = new AuthenticationClient();
const ossClient = new OssClient();

let router = express.Router();

// Helper function to convert object ID to URN (base64)
function urnify(id) {
    return Buffer.from(id).toString('base64').replace(/=/g, '');
}

async function getInternalToken() {
    const credentials = await authenticationClient.getTwoLeggedToken(config.client_id, config.client_secret, [
        Scopes.DataRead,
        Scopes.DataCreate,
        Scopes.DataWrite,
        Scopes.BucketCreate,
        Scopes.BucketRead
    ]);
    return credentials.access_token;
}

async function ensureBucketExists(bucketKey) {
    const accessToken = await getInternalToken();
    try {
        await ossClient.getBucketDetails(bucketKey, { accessToken });
    } catch (err) {
        if (err.axiosError && err.axiosError.response && err.axiosError.response.status === 404) {
            await ossClient.createBucket(Region.Us, { bucketKey: bucketKey, policyKey: PolicyKey.Persistent }, { accessToken });
        } else {
            throw err;
        }
    }
}

// GET /api/data/models
// Lists URNs and names of all available Forge models
router.get('/models', async function (req, res, next) {
    try {
        await ensureBucketExists(config.bucket);
        const accessToken = await getInternalToken();
        let resp = await ossClient.getObjects(config.bucket, { limit: 64, accessToken });
        let objects = resp.items;
        while (resp.next) {
            const startAt = new URL(resp.next).searchParams.get('startAt');
            resp = await ossClient.getObjects(config.bucket, { limit: 64, startAt, accessToken });
            objects = objects.concat(resp.items);
        }
        res.json(objects.map(obj => ({
            name: obj.objectKey,
            urn: urnify(obj.objectId)
        })));
    } catch (err) {
        next(err);
    }
});

module.exports = router;