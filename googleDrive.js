const { google } = require('googleapis');
const fs = require('fs');

class GoogleDriveService {
    constructor(credentials) {
        let auth;
        if (typeof credentials === 'string' && fs.existsSync(credentials)) {
            // Path to JSON file
            auth = new google.auth.GoogleAuth({
                keyFile: credentials,
                scopes: ['https://www.googleapis.com/auth/drive'],
            });
        } else {
            // JSON string or object
            const keys = typeof credentials === 'string' ? JSON.parse(credentials) : credentials;
            auth = new google.auth.GoogleAuth({
                credentials: keys,
                scopes: ['https://www.googleapis.com/auth/drive'],
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

    async uploadFile(filePath, fileName) {
        try {
            const media = {
                mimeType: 'application/x-sqlite3',
                body: fs.createReadStream(filePath),
            };
            const fileMetadata = {
                name: fileName,
            };

            // Check if file already exists to update it instead of creating duplicates
            const existingFile = await this.findFileByName(fileName);
            
            if (existingFile) {
                const response = await this.drive.files.update({
                    fileId: existingFile.id,
                    media: media,
                });
                return response.data;
            } else {
                const response = await this.drive.files.create({
                    requestBody: fileMetadata,
                    media: media,
                    fields: 'id',
                });
                return response.data;
            }
        } catch (err) {
            console.error('Error uploading file to Google Drive:', err.message);
            throw err;
        }
    }

    async findFileByName(fileName) {
        try {
            const response = await this.drive.files.list({
                q: `name = '${fileName}' and trashed = false`,
                fields: 'files(id, name)',
                spaces: 'drive',
            });
            return response.data.files[0];
        } catch (err) {
            console.error('Error searching for file on Google Drive:', err.message);
            throw err;
        }
    }

    async downloadFile(fileId, destinationPath) {
        try {
            const dest = fs.createWriteStream(destinationPath);
            const response = await this.drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );

            return new Promise((resolve, reject) => {
                response.data
                    .on('end', () => {
                        console.log('Done downloading database.');
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error('Error downloading database.');
                        reject(err);
                    })
                    .pipe(dest);
            });
        } catch (err) {
            console.error('Error downloading file from Google Drive:', err.message);
            throw err;
        }
    }
}

module.exports = GoogleDriveService;
