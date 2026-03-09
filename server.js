'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const SPOONACULAR_KEY = process.env.SPOONACULAR_KEY;
const MERCATO_URL = 'https://www.mercato.com/shop/jubilee-marketplace-greenpoint-brooklyn';

// Strip weights, units, marketing words; return the core 1-2 word ingredient
function cleanIngredient(raw) {
  return raw
    .toLowerCase()
    .replace(/\b(organic|fresh|local|farm|wild|frozen|grade\s*a|premium|natural|raw|boneless|skinless|whole|sliced|diced|chopped)\b/g, '')
    .replace(/\d+(\.\d+)?\s*(lb|lbs|oz|g|kg|ml|l|ct|pk|pck|pkg|each|per|count)\.?\b/gi, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ')
    .trim();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// Scrape Mercato for sale / featured items (Puppeteer — full JS render)
// ---------------------------------------------------------------------------
async function scrapeSaleItems() {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 900 });

    console.log('[scraper] navigating to Mercato…');
    await page.goto(MERCATO_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // Wait for at least one product card to appear in the live DOM
    const productSelector =
      '[class*="product-card"], [class*="ProductCard"], ' +
      '[class*="product_card"], [class*="item-card"], [class*="ItemCard"], ' +
      '[data-testid*="product"], [data-cy*="product"]';

    await page.waitForSelector(productSelector, { timeout: 20000 }).catch(() => {
      console.log('[scraper] product selector timeout — scraping whatever is loaded');
    });

    // Small extra wait for lazy-loaded sale badges to appear
    await new Promise(r => setTimeout(r, 2000));

    const ingredients = await page.evaluate(() => {
      // Normalise a raw product name into a clean ingredient string
      const clean = (text) => {
        const noise = /\b(organic|fresh|local|farm|wild|caught|raised|frozen|grade\s*a|premium|natural|raw|boneless|skinless|whole|sliced|diced|chopped|cooked|smoked|dried|cured|roasted|plain|original|classic|traditional|family|large|small|medium|extra|super|mega|value|pack|assorted|variety|mixed|blend|mix|pasture|antibiotic|hormone|free|no|fed|grass|the|on|in|with|and|from|by|of|net|wt)\b/gi;
        return text
          .replace(/\s*[,\-–]\s*\d.*$/, '')    // drop "- 5 Pounds", ", 32 oz" etc.
          .replace(/\d+(\.\d+)?\s*(lb|lbs|oz|g|kg|ml|fl\s*oz|fluid\s*ounces?|gallons?|count|ct|pk|pck|pkg|each|per|rolls?|pieces?|units?)\.?\b/gi, '')
          .replace(noise, ' ')
          .replace(/[^a-zA-Z\s'&]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      };

      // Keep only words that look like real food nouns (≥3 chars, not a stop word)
      const JUNK = /^(the|on|in|with|and|from|by|of|no|net|wt|per|each|add|like|view|more|cart)$/i;
      const toIngredient = (raw) => {
        const words = clean(raw).split(' ').filter(w => w.length >= 3 && !JUNK.test(w));
        if (words.length === 0) return '';
        // Take up to 3 meaningful words
        return words.slice(0, 3).join(' ');
      };

      // Extract product names from all items in a given carousel section
      const getNamesFromSection = (sectionName) => {
        const h2s = [...document.querySelectorAll('h2')];
        const heading = h2s.find(h => h.textContent.trim() === sectionName);
        if (!heading) return [];

        const carousel = heading.closest('[class*="ProductCarousel_productCarousel"]');
        if (!carousel) return [];

        const items = [...carousel.querySelectorAll('[class*="BaseProductCarousel_item"]')];
        const names = [];
        items.forEach(item => {
          // Gather all leaf text nodes, exclude price/unit patterns and UI strings
          const leaves = [...item.querySelectorAll('*')].filter(e => {
            if (e.children.length !== 0) return false;
            const t = e.textContent.trim();
            if (t.length < 4 || t.length > 120) return false;
            if (/^\$|^per |^add to|^like$|^each$|^\d+$/i.test(t)) return false;
            return true;
          });
          // The longest leaf text is usually the product name
          const longest = leaves.reduce((best, e) => {
            const t = e.textContent.trim();
            return t.length > best.length ? t : best;
          }, '');
          if (longest) names.push(longest);
        });
        return names;
      };

      const found = new Set();
      const isValid = (s) => s && s.length > 3 && s.split(' ').length >= 1;

      // Priority 1: Featured section (store-curated highlighted items)
      const featured = getNamesFromSection('Featured');
      featured.forEach(n => { const c = toIngredient(n); if (isValid(c)) found.add(c); });

      // Priority 2: Food categories that typically have sale/seasonal items
      const fallbackSections = ['Fruits & Veggies', 'Seafood', 'Meat', 'Dairy & Refrigerated'];
      if (found.size < 5) {
        for (const sec of fallbackSections) {
          const names = getNamesFromSection(sec);
          names.slice(0, 3).forEach(n => { const c = toIngredient(n); if (isValid(c)) found.add(c); });
          if (found.size >= 8) break;
        }
      }

      return [...found].filter(Boolean).slice(0, 10);
    });

    console.log('[scraper] found ingredients:', ingredients);
    return ingredients;
  } finally {
    await browser.close();
  }
}

// Confirm a string is a real food ingredient via Spoonacular's ingredient search.
// Returns the canonical name Spoonacular uses, or null if not recognised.
async function validateIngredient(candidate) {
  if (!SPOONACULAR_KEY) return candidate; // can't validate without key, pass through
  try {
    const { data } = await axios.get('https://api.spoonacular.com/food/ingredients/search', {
      params: { query: candidate, number: 1, apiKey: SPOONACULAR_KEY },
      timeout: 6000,
    });
    const hit = data.results?.[0];
    return hit ? hit.name : null;
  } catch {
    return null; // network error — drop the candidate rather than risk bad data
  }
}

app.get('/api/sale-items', async (req, res) => {
  try {
    const candidates = await scrapeSaleItems();
    if (!candidates || candidates.length === 0) {
      return res.status(404).json({
        error: 'No sale items detected on the page.',
        fallback: true,
      });
    }

    // Validate all candidates in parallel against Spoonacular's ingredient index
    console.log('[sale-items] validating', candidates.length, 'candidates…');
    const validated = await Promise.all(candidates.map(c => validateIngredient(c)));
    const ingredients = validated.filter(Boolean);
    console.log('[sale-items] passed validation:', ingredients);

    if (ingredients.length === 0) {
      return res.status(404).json({
        error: 'Scraped items could not be matched to any recognised food ingredients.',
        fallback: true,
      });
    }

    res.json({ ingredients, source: 'puppeteer' });
  } catch (err) {
    console.error('[sale-items] error:', err.message);
    res.status(502).json({ error: `Scraping failed: ${err.message}`, fallback: true });
  }
});

// ---------------------------------------------------------------------------
// Spoonacular recipe search
// ---------------------------------------------------------------------------
app.get('/api/recipes', async (req, res) => {
  const { ingredients } = req.query;

  if (!ingredients) {
    return res.status(400).json({ error: 'ingredients query param required' });
  }

  if (!SPOONACULAR_KEY) {
    return res.status(500).json({
      error: 'SPOONACULAR_KEY environment variable is not set on the server.',
    });
  }

  try {
    // Run recipe search and wine pairing lookup in parallel
    const [searchResp, wineResp] = await Promise.all([
      axios.get('https://api.spoonacular.com/recipes/complexSearch', {
        params: {
          includeIngredients: ingredients,
          sort: 'popularity',
          sortDirection: 'desc',
          number: 8,
          addRecipeInformation: true,
          fillIngredients: false,
          apiKey: SPOONACULAR_KEY,
        },
        timeout: 15000,
      }),
      axios.get('https://api.spoonacular.com/food/wine/pairing', {
        params: {
          food: ingredients.split(',')[0].trim(), // pair on primary ingredient
          apiKey: SPOONACULAR_KEY,
        },
        timeout: 10000,
      }).catch(() => null), // wine pairing is best-effort
    ]);

    const winePairing = wineResp?.data?.pairedWines?.length
      ? {
          wines: wineResp.data.pairedWines.slice(0, 3),
          text: wineResp.data.pairingText || null,
        }
      : null;

    const recipes = (searchResp.data.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      image: r.image || null,
      readyInMinutes: r.readyInMinutes || null,
      rating: r.spoonacularScore ? Math.round(r.spoonacularScore) : null,
      servings: r.servings || null,
      sourceUrl: r.sourceUrl || `https://spoonacular.com/recipes/${r.id}`,
      cuisines: r.cuisines || [],
      dishTypes: r.dishTypes || [],
      winePairing,
    }));

    res.json({ recipes, totalResults: searchResp.data.totalResults });
  } catch (err) {
    const status = err.response?.status;
    const msg =
      status === 402
        ? 'Spoonacular quota exceeded. Check your plan.'
        : status === 401
        ? 'Invalid Spoonacular API key.'
        : err.message;
    console.error('[recipes] error:', msg);
    res.status(502).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\nJubilee Recipes server  →  http://localhost:${PORT}`);
  if (!SPOONACULAR_KEY) {
    console.warn(
      'WARNING: SPOONACULAR_KEY is not set.\n' +
      'Start the server with:  SPOONACULAR_KEY=yourkey node server.js\n'
    );
  }
});
