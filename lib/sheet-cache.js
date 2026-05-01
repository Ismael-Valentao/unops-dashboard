/**
 * Cache partilhada das linhas da Google Sheet (dashboard público).
 * app.js mantém populada via fetchCSV; outros módulos podem ler para
 * reconciliação contra o que está na DB.
 */
const cache = {
  data: [],            // array de rows parseadas de parseCSV
  lastUpdated: null,   // ISO timestamp da última actualização
};

function get()                { return cache; }
function setData(rows, ts)    { cache.data = rows || []; cache.lastUpdated = ts || new Date().toISOString(); }

module.exports = { get, setData, cache };
