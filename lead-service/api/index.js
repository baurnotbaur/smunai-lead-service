/**
 * Точка входа для Vercel: платформа делает функцию из каждого файла в api/,
 * а vercel.json заворачивает сюда все запросы к /api/*.
 */

import { handleRequest } from '../src/app.js';

export default handleRequest;
