/* VIN Decoder and Recall Checker, Version 1
 *
 * What it does:
 *   1. Checks the VIN format and check digit locally (no network needed).
 *   2. Decodes the VIN with NHTSA's vPIC API.
 *   3. Looks up US recalls with NHTSA's recallsByVehicle API (by make, model, year).
 *   4. Links to Transport Canada for the official Canadian recall lookup.
 *
 * No API keys, no server, no build step.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const API = {
  decode: 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/',
  recalls: 'https://api.nhtsa.gov/recalls/recallsByVehicle',
  models: 'https://api.nhtsa.gov/products/vehicle/models',
};

const TRANSPORT_CANADA_URL =
  'https://tc.canada.ca/en/road-transportation/defects-recalls-vehicles-tires-child-car-seats';

const EXAMPLE_VIN = '1HGCM82633A004352';
const REQUEST_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* 1. VIN validation (pure logic, easy to test)                        */
/* ------------------------------------------------------------------ */

// Letters are converted to numbers for the check digit calculation.
const LETTER_VALUES = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

// Each of the 17 positions has a weight. Position 9 (the check digit) has weight 0.
const POSITION_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const ALLOWED_CHARACTER = /^[A-HJ-NPR-Z0-9]$/; // no I, O or Q

function cleanVin(raw) {
  return String(raw || '').toUpperCase().replace(/[\s-]/g, '');
}

// Returns true if position 9 matches the calculated check digit.
// Only call this with a VIN that already passed the format check.
function checkDigitMatches(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : LETTER_VALUES[ch];
    sum += value * POSITION_WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return vin[8] === expected;
}

function validateVin(vin) {
  const problems = [];

  if (vin.length === 0) {
    problems.push('Enter a VIN to get started.');
  } else {
    if (vin.length !== 17) {
      problems.push(`A VIN has exactly 17 characters. You entered ${vin.length}.`);
    }
    const bad = [...new Set(vin.match(/[^A-HJ-NPR-Z0-9]/g) || [])];
    if (bad.length) {
      problems.push(
        `These characters are not allowed in a VIN: ${bad.join(', ')}. ` +
        'The letters I, O and Q are never used because they look like 1 and 0.'
      );
    }
  }

  const ok = problems.length === 0;
  return { ok, problems, checkDigitOk: ok ? checkDigitMatches(vin) : null };
}

/* ------------------------------------------------------------------ */
/* 2. Talking to NHTSA                                                 */
/* ------------------------------------------------------------------ */

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function decodeVin(vin) {
  const data = await fetchJson(`${API.decode}${encodeURIComponent(vin)}?format=json`);
  const row = data && data.Results && data.Results[0];
  if (!row) throw new Error('Unexpected response from NHTSA vPIC');
  return row;
}

async function fetchRecalls(make, model, year) {
  const params = new URLSearchParams({ make, model, modelYear: year });
  const data = await fetchJson(`${API.recalls}?${params}`);
  return Array.isArray(data.results) ? data.results : [];
}

// Lowercase and strip punctuation so "CR-V" and "CRV" compare equal.
const normalize = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// NHTSA's recall database sometimes spells a model differently from the VIN decoder.
// If the first lookup finds nothing, ask NHTSA which model names it has for that
// make and year, and retry once with the closest match.
async function getUsRecalls(make, model, year) {
  const first = await fetchRecalls(make, model, year);
  if (first.length) return { recalls: first, modelUsed: model, renamed: false };

  try {
    const params = new URLSearchParams({ modelYear: year, make, issueType: 'r' });
    const data = await fetchJson(`${API.models}?${params}`);
    const names = (data.results || []).map((r) => r.model || r.Model).filter(Boolean);

    const target = normalize(model);
    const match =
      names.find((n) => normalize(n) === target) ||
      names.find((n) => normalize(n).startsWith(target) || target.startsWith(normalize(n)));

    if (match && match !== model) {
      const retry = await fetchRecalls(make, match, year);
      return { recalls: retry, modelUsed: match, renamed: true };
    }
  } catch (err) {
    // The fallback is a bonus. If it fails, the empty first result still stands.
  }

  return { recalls: [], modelUsed: model, renamed: false };
}

/* ------------------------------------------------------------------ */
/* 3. Turning API data into something readable                         */
/* ------------------------------------------------------------------ */

function titleCase(text) {
  if (!text) return '';
  if (text.length <= 3) return text.toUpperCase(); // BMW, GMC, RAM
  return text.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

function readVehicle(row) {
  const displacement = parseFloat(row.DisplacementL);
  const horsepower = parseFloat(row.EngineHP);
  const engineParts = [];
  if (!Number.isNaN(displacement)) engineParts.push(`${displacement.toFixed(1)} L`);
  if (row.EngineCylinders) engineParts.push(`${row.EngineCylinders}-cylinder`);

  const assembled = [row.PlantCity && titleCase(row.PlantCity), row.PlantCountry]
    .filter(Boolean)
    .join(', ');

  // ErrorCode "0" means NHTSA decoded the VIN cleanly.
  const nhtsaNote = row.ErrorCode && String(row.ErrorCode).trim() !== '0' ? row.ErrorText : '';

  return {
    year: row.ModelYear || '',
    makeRaw: row.Make || '',
    make: titleCase(row.Make),
    model: row.Model || '',
    trim: row.Trim || row.Series || '',
    body: row.BodyClass || '',
    drive: row.DriveType || '',
    engine: engineParts.join(', '),
    horsepower: Number.isNaN(horsepower) ? '' : `${Math.round(horsepower)} hp`,
    fuel: row.FuelTypePrimary || '',
    transmission: row.TransmissionStyle || '',
    doors: row.Doors || '',
    assembled,
    manufacturer: row.Manufacturer || '',
    nhtsaNote,
    identified: Boolean(row.Make && row.Model && row.ModelYear),
  };
}

// NHTSA dates look like "26/08/2020" (day/month/year).
function parseNhtsaDate(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text || '');
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : null;
}

function formatDate(text) {
  const date = parseNhtsaDate(text);
  if (!date) return text || 'Date not listed';
  return date.toLocaleDateString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function newestFirst(a, b) {
  const da = parseNhtsaDate(a.ReportReceivedDate);
  const db = parseNhtsaDate(b.ReportReceivedDate);
  return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
}

function networkMessage(err) {
  if (err && err.name === 'AbortError') {
    return 'NHTSA took too long to respond. Try again in a moment.';
  }
  if (err instanceof TypeError) {
    return 'Could not reach NHTSA. If your internet is working, the browser or the site hosting this page ' +
      'may be blocking the request. Open the browser console (F12) for details.';
  }
  return `NHTSA sent back something unexpected (${err.message}). Try again in a moment.`;
}

/* ------------------------------------------------------------------ */
/* 4. Page (only runs in a browser)                                    */
/* ------------------------------------------------------------------ */

let els = {};
let runId = 0;          // lets us ignore results from an older lookup
let currentReport = ''; // plain text version for "Copy report"
let currentVin = '';

// Small helper for building elements. Using textContent (never innerHTML)
// means text from the API can't inject HTML into the page.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

function setStatus(message, kind = '') {
  els.status.className = kind ? `status ${kind}` : 'status';
  els.status.textContent = message;
}

function buildCells() {
  for (let i = 0; i < 17; i++) {
    els.cells.append(el('span', { class: i === 8 ? 'cell check' : 'cell' }));
  }
}

function updateCells() {
  const vin = cleanVin(els.input.value);
  [...els.cells.children].forEach((cell, i) => {
    const ch = vin[i] || '';
    cell.textContent = ch;
    cell.classList.toggle('filled', Boolean(ch));
    cell.classList.toggle('bad', Boolean(ch) && !ALLOWED_CHARACTER.test(ch));
  });
  els.count.textContent = `${vin.length} / 17`;
  els.count.classList.toggle('over', vin.length > 17);
}

function clearResults() {
  els.results.hidden = true;
  els.vehicle.replaceChildren();
  els.recalls.replaceChildren();
  els.canada.replaceChildren();
  currentReport = '';
}

function renderVehicle(vehicle, vin, validation) {
  const specs = [
    ['Year', vehicle.year],
    ['Make', vehicle.make],
    ['Model', vehicle.model],
    ['Trim', vehicle.trim],
    ['Body', vehicle.body],
    ['Drivetrain', vehicle.drive],
    ['Engine', vehicle.engine],
    ['Power', vehicle.horsepower],
    ['Fuel', vehicle.fuel],
    ['Transmission', vehicle.transmission],
    ['Doors', vehicle.doors],
    ['Assembled in', vehicle.assembled],
    ['Manufacturer', vehicle.manufacturer],
  ].filter(([, value]) => value);

  const title = vehicle.identified
    ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
    : 'Vehicle not identified';

  els.vehicle.append(
    el('h2', { id: 'vehicle-title' }, 'Vehicle'),
    el('p', { class: 'vehicle-title' }, title),
    el('p', {}, `VIN ${vin}`)
  );

  if (!validation.checkDigitOk) {
    els.vehicle.append(el('p', { class: 'notice' },
      'This VIN fails the North American check digit test. That can mean a typo, or a vehicle built for ' +
      'another market where the check digit is not used. Compare it with the VIN on the vehicle.'));
  }

  if (!vehicle.identified) {
    els.vehicle.append(el('p', { class: 'notice' },
      'NHTSA could not match this VIN to a make, model and year. Vehicles built for markets outside ' +
      'North America are often missing from its data. Check the VIN for typos, or try the manufacturer or Transport Canada.'));
  } else if (vehicle.nhtsaNote) {
    els.vehicle.append(el('p', { class: 'notice' }, `NHTSA note: ${vehicle.nhtsaNote}`));
  }

  if (specs.length) {
    els.vehicle.append(
      el('dl', { class: 'specs' },
        specs.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value))))
    );
  }

  currentReport =
    `VIN report: ${vin}\n${title}\n` +
    specs.map(([label, value]) => `${label}: ${value}`).join('\n') + '\n';
}

function renderRecalls(vehicle, result) {
  const { recalls, modelUsed, renamed } = result;
  const label = `${vehicle.year} ${vehicle.make} ${modelUsed}`;

  els.recalls.append(el('h2', { id: 'recalls-title' }, 'US safety recalls'));

  if (renamed) {
    els.recalls.append(el('p', { class: 'notice' },
      `NHTSA's recall database lists this model as "${modelUsed}", so that name was used for the search.`));
  }

  if (recalls.length === 0) {
    els.recalls.append(
      el('p', { class: 'empty' },
        `NHTSA lists no recalls for the ${label}. This covers US recalls only, so check Transport Canada too.`)
    );
    currentReport += `\nUS recalls: none listed for the ${label}.\n`;
    return;
  }

  const sorted = [...recalls].sort(newestFirst);
  const count = sorted.length === 1 ? '1 recall' : `${sorted.length} recalls`;

  els.recalls.append(
    el('p', {},
      `${count} found for the ${label}. These are matched by make, model and year, so a recall may not ` +
      'apply to this exact vehicle, or may already have been repaired.'),
    el('ul', { class: 'recall-list' },
      sorted.map((r) => {
        const number = r.NHTSACampaignNumber || 'Unknown';
        return el('li', {},
          el('details', { class: 'recall' },
            el('summary', {},
              el('span', { class: 'component' }, r.Component || 'Component not listed'),
              r.parkIt ? ' ' : null,
              r.parkIt ? el('span', { class: 'badge' }, 'NHTSA advises not driving') : null,
              el('span', { class: 'meta' }, `Reported ${formatDate(r.ReportReceivedDate)}, campaign ${number}`)
            ),
            el('div', { class: 'recall-body' },
              r.Summary ? [el('h3', {}, 'What is wrong'), el('p', {}, r.Summary)] : null,
              r.Consequence ? [el('h3', {}, 'Risk'), el('p', {}, r.Consequence)] : null,
              r.Remedy ? [el('h3', {}, 'Fix'), el('p', {}, r.Remedy)] : null,
              number !== 'Unknown'
                ? el('p', {}, el('a', {
                    href: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(number)}`,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, 'View on NHTSA'))
                : null
            )
          )
        );
      })
    )
  );

  currentReport += `\nUS recalls for the ${label}: ${sorted.length}\n` +
    sorted.map((r) =>
      `- ${r.Component || 'Component not listed'} (reported ${formatDate(r.ReportReceivedDate)}, ` +
      `campaign ${r.NHTSACampaignNumber || 'unknown'})`).join('\n') + '\n';
}

function renderRecallsError(err) {
  els.recalls.append(
    el('h2', { id: 'recalls-title' }, 'US safety recalls'),
    el('p', { class: 'notice' }, networkMessage(err))
  );
}

function renderRecallsSkipped() {
  els.recalls.append(
    el('h2', { id: 'recalls-title' }, 'US safety recalls'),
    el('p', {}, 'Recalls are looked up by make, model and year, so they cannot be checked until the VIN is identified.')
  );
}

function renderCanada(vin) {
  els.canada.append(
    el('h2', { id: 'canada-title' }, 'Canadian recalls'),
    el('p', {},
      'The recalls above come from the US database and can differ from Canada. Transport Canada runs the ' +
      'official Canadian lookup, including a search by VIN. Copy the VIN, then paste it there.'),
    el('div', { class: 'actions' },
      el('a', {
        class: 'btn primary',
        href: TRANSPORT_CANADA_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'Open Transport Canada recalls'),
      el('button', { type: 'button', class: 'btn', id: 'copy-vin-btn' }, 'Copy VIN')
    )
  );
  $('copy-vin-btn').addEventListener('click', () => copyText(vin, 'VIN copied.'));
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(message);
  } catch (err) {
    setStatus('Copying is blocked in this browser. Select the text and copy it manually.', 'error');
  }
}

async function runLookup() {
  const vin = cleanVin(els.input.value);
  const validation = validateVin(vin);

  if (!validation.ok) {
    clearResults();
    setStatus(validation.problems.join(' '), 'error');
    els.input.focus();
    return;
  }

  const thisRun = ++runId;
  currentVin = vin;
  clearResults();
  els.decodeBtn.disabled = true;
  setStatus('Decoding VIN with NHTSA...');

  try {
    const vehicle = readVehicle(await decodeVin(vin));
    if (thisRun !== runId) return;

    renderVehicle(vehicle, vin, validation);
    els.results.hidden = false;

    if (!vehicle.identified) {
      renderRecallsSkipped();
      renderCanada(vin);
      setStatus('');
      return;
    }

    setStatus('Checking US recalls...');
    try {
      const result = await getUsRecalls(vehicle.makeRaw, vehicle.model, vehicle.year);
      if (thisRun !== runId) return;
      renderRecalls(vehicle, result);
    } catch (err) {
      if (thisRun !== runId) return;
      renderRecallsError(err);
    }
    renderCanada(vin);
    setStatus('');
  } catch (err) {
    if (thisRun !== runId) return;
    setStatus(networkMessage(err), 'error');
  } finally {
    if (thisRun === runId) els.decodeBtn.disabled = false;
  }
}

function resetAll() {
  runId += 1; // cancels any lookup still in flight
  els.input.value = '';
  els.decodeBtn.disabled = false;
  clearResults();
  setStatus('');
  updateCells();
  els.input.focus();
}

function init() {
  els = {
    form: $('vin-form'),
    input: $('vin-input'),
    cells: $('cells'),
    count: $('vin-count'),
    status: $('status'),
    results: $('results'),
    vehicle: $('vehicle'),
    recalls: $('recalls'),
    canada: $('canada'),
    decodeBtn: $('decode-btn'),
  };

  buildCells();
  updateCells();

  els.input.addEventListener('input', updateCells);
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runLookup();
  });

  $('example-btn').addEventListener('click', () => {
    els.input.value = EXAMPLE_VIN;
    updateCells();
    runLookup();
  });
  $('clear-btn').addEventListener('click', resetAll);
  $('copy-report-btn').addEventListener('click', () => copyText(currentReport, 'Report copied.'));
  $('print-btn').addEventListener('click', () => window.print());

  // Recalls are collapsed on screen. Open them all while printing.
  let wasOpen = [];
  window.addEventListener('beforeprint', () => {
    const all = [...document.querySelectorAll('details.recall')];
    wasOpen = all.map((d) => d.open);
    all.forEach((d) => { d.open = true; });
  });
  window.addEventListener('afterprint', () => {
    document.querySelectorAll('details.recall').forEach((d, i) => { d.open = Boolean(wasOpen[i]); });
  });
}

function $(id) { return document.getElementById(id); }

if (typeof document !== 'undefined') {
  init();
}

// Lets you test the pure functions with Node: node -e "require('./script.js')"
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cleanVin, validateVin, checkDigitMatches, normalize, titleCase, formatDate };
}
