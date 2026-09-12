exports.handler = async function(event) {
  const JSONBIN_ID = '6a6c0652f5f4af5e29d84f42';
  const JSONBIN_KEY = '$2a$10$u8gWlZiVd8uJ173bMF4t5erja/SvH3VSjbYWCuDLvBimY/vKd/V1y';
  const url = 'https://api.jsonbin.io/v3/b/' + JSONBIN_ID;

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  try {
    if (event.httpMethod === 'GET') {
      const res = await fetch(url + '/latest', {
        headers: { 'X-Access-Key': JSONBIN_KEY, 'X-Bin-Meta': 'false' }
      });
      const text = await res.text();
      return { statusCode: res.status, headers: corsHeaders, body: text };
    }

    if (event.httpMethod === 'PUT' || event.httpMethod === 'POST') {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Access-Key': JSONBIN_KEY },
        body: event.body
      });
      const text = await res.text();
      return { statusCode: res.status, headers: corsHeaders, body: text };
    }

    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
