require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');

const authenticateRequest = require('./middleware/auth');
const apiLimiter = require('./middleware/rateLimit');
const authRoutes = require('./routes/authRoutes');
const apiRoutes = require('./routes/apiRoutes');
const cors = require ('cors')
const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} request for: ${req.originalUrl}`);
  next();
});


app.use(cors());

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.use('/auth', authRoutes);
app.use('/api',apiLimiter,authenticateRequest, apiRoutes);

app.listen(port, () => {
  console.log(`API Server running on port ${port}`);
});