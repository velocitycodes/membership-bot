const { google } = require('googleapis');
const fs = require('fs');

class GoogleDriveService {
    constructor(credentials) {
        let auth;
        if (typeof credentials === 'string' && fs.existsSync(credentials)) {
            // Path to JSON file
            auth = new google.auth.GoogleAuth({
                keyFile: credentials,
                scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            });
        } else {
            // JSON string or object
            const keys = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
            auth = new google.auth.GoogleAuth({
                credentials: keys,
                scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            });
        }
        this.drive = google.drive({ version: 'v3', auth });
    }

    async getFileStream(fileId) {
        try {
            const response = await this.drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );
            return response.data;
        } catch (err) {
            console.error('Error fetching file from Google Drive:', err.message);
            throw err;
        }
    }

    async getFileInfo(fileId) {
        try {
            const response = await this.drive.files.get({
                fileId,
                fields: 'id, name, mimeType, size'
            });
            return response.data;
        } catch (err) {
            console.error('Error fetching file info from Google Drive:', err.message);
            throw err;
        }
    }
}

module.exports = GoogleDriveService;
