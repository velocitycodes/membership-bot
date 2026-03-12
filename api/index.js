const { bot, initBackupSystem } = require('../index');

module.exports = async (req, res) => {
  try {
    // Ensure database is initialized/restored in /tmp
    await initBackupSystem();

    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Bot is running on Vercel. Database is active in /tmp.');
    }
  } catch (err) {
    console.error('Vercel API Error:', err);
    res.status(500).send('Internal Server Error');
  }
};
