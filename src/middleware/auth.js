const API_SECRET_TOKEN = process.env.API_SECRET_TOKEN;

module.exports = function authenticateRequest(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    // Temporary debug logging
    console.log('Expected token:', API_SECRET_TOKEN);
    console.log('Received token:', token);
    console.log('Auth header:', authHeader);
    
    if (!token) return res.status(401).json({ message: 'Missing token' });
    if (token !== API_SECRET_TOKEN) return res.status(403).json({ message: 'Invalid token' });
    
    next();
};