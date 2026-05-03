const express = require('express');
const cors = require('cors');
const DISEASES = require('./diseases');

const app = express();
app.use(cors());
app.use(express.json());

// ─── BUILD INDEXES ON STARTUP ────────────────────────────────────────────────
// Index diseases by id for O(1) lookup
const DISEASE_BY_ID = {};
DISEASES.forEach(d => { DISEASE_BY_ID[d.id] = d; });

// Collect all unique symptoms across all diseases
const ALL_SYMPTOMS = [...new Set(DISEASES.flatMap(d => d.symptoms))].sort();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function scoreMatch(disease, userSymptoms) {
  // How many of the user's symptoms match this disease
  const matched = userSymptoms.filter(s => disease.symptoms.includes(s));
  if (matched.length === 0) return null;

  const matchRatio    = matched.length / userSymptoms.length;   // coverage of user input
  const diseaseRatio  = matched.length / disease.symptoms.length; // coverage of disease profile

  // Weighted score — rewards both coverage of user input AND specificity
  const score = (matchRatio * 0.6) + (diseaseRatio * 0.4);

  return {
    matchedSymptoms:   matched,
    totalMatched:      matched.length,
    matchPercentage:   Math.round(score * 100),
    score,
  };
}

function buildConditionResponse(disease, matchInfo = null) {
  return {
    id:            disease.id,
    name:          disease.name,
    summary:       disease.summary,
    urgency:       disease.urgency,
    symptoms:      disease.symptoms,
    bodyAreas:     disease.bodyAreas,
    causes:        disease.causes,
    selfCare:      disease.selfCare,
    seeDoctor:     disease.seeDoctor,
    imageCategory: disease.imageCategory,
    ...(matchInfo && {
      matchedSymptoms:   matchInfo.matchedSymptoms,
      totalMatched:      matchInfo.totalMatched,
      matchPercentage:   matchInfo.matchPercentage,
    }),
  };
}

// ─── ROOT ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name:        'DermaGuide API',
    version:     '2.0.0',
    description: 'Dermatology symptom checker and condition reference API',
    totalDiseases: DISEASES.length,
    endpoints: {
      symptoms:         'GET  /api/symptoms',
      analyzeSymptoms:  'POST /api/symptoms/analyze',
      allConditions:    'GET  /api/conditions',
      conditionById:    'GET  /api/conditions/:id',
      searchConditions: 'GET  /api/conditions/search?q=keyword',
      bookings:         'POST /api/bookings',
      getBookings:      'GET  /api/bookings',
    },
  });
});

// ─── GET ALL SYMPTOMS ────────────────────────────────────────────────────────
// Called by: SymptomService.getAllSymptoms()
// Returns: { symptoms: [...] }
app.get('/api/symptoms', (req, res) => {
  res.json({ symptoms: ALL_SYMPTOMS });
});

// ─── ANALYZE SYMPTOMS ────────────────────────────────────────────────────────
// Called by: SymptomService.matchSymptoms(userSymptoms)
// Body:    { symptoms: ["itching", "redness", ...] }
// Returns: { matches, requiresUrgentCare, requiresDoctorVisit }
app.post('/api/symptoms/analyze', (req, res) => {
  const { symptoms: userSymptoms } = req.body;

  if (!userSymptoms || !Array.isArray(userSymptoms) || userSymptoms.length === 0) {
    return res.status(400).json({ error: 'Please provide a non-empty symptoms array.' });
  }

  // Normalise input — lowercase, trim
  const cleaned = userSymptoms.map(s => s.toLowerCase().trim());

  // Score every disease
  const scored = DISEASES
    .map(disease => {
      const info = scoreMatch(disease, cleaned);
      if (!info) return null;
      return { disease, info };
    })
    .filter(Boolean)
    .sort((a, b) => b.info.score - a.info.score)
    .slice(0, 10); // top 10 matches

  const matches = scored.map(({ disease, info }) =>
    buildConditionResponse(disease, info)
  );

  const requiresUrgentCare  = matches.some(m => m.urgency === 'high');
  const requiresDoctorVisit = matches.some(m => m.urgency === 'medium' || m.urgency === 'high');

  res.json({ matches, requiresUrgentCare, requiresDoctorVisit });
});

// ─── GET ALL CONDITIONS ───────────────────────────────────────────────────────
// Called by: LearnScreen — lists all diseases
// Query params: ?urgency=low|medium|high  &category=eczema|acne|...  &limit=20&offset=0
app.get('/api/conditions', (req, res) => {
  const { urgency, category, limit = 50, offset = 0 } = req.query;

  let results = [...DISEASES];

  if (urgency) {
    results = results.filter(d => d.urgency === urgency);
  }
  if (category) {
    results = results.filter(d => d.imageCategory === category);
  }

  const total      = results.length;
  const paginated  = results.slice(Number(offset), Number(offset) + Number(limit));

  res.json({
    total,
    limit:      Number(limit),
    offset:     Number(offset),
    conditions: paginated.map(d => buildConditionResponse(d)),
  });
});

// ─── SEARCH CONDITIONS ────────────────────────────────────────────────────────
// Called by: LearnScreen search bar
// Query: ?q=psoriasis
app.get('/api/conditions/search', (req, res) => {
  const { q } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
  }

  const keyword = q.toLowerCase().trim();

  const results = DISEASES.filter(d =>
    d.name.toLowerCase().includes(keyword) ||
    d.summary.toLowerCase().includes(keyword) ||
    d.symptoms.some(s => s.includes(keyword)) ||
    (d.causes && d.causes.some(c => c.toLowerCase().includes(keyword)))
  );

  res.json({
    query:      q,
    total:      results.length,
    conditions: results.map(d => buildConditionResponse(d)),
  });
});

// ─── GET CONDITION BY ID ──────────────────────────────────────────────────────
// Called by: ConditionDetailScreen
// Route: /api/conditions/:id   e.g. /api/conditions/atopic_dermatitis
app.get('/api/conditions/:id', (req, res) => {
  // Must come AFTER /api/conditions/search to avoid route conflict
  const disease = DISEASE_BY_ID[req.params.id];
  if (!disease) {
    return res.status(404).json({ error: `Condition '${req.params.id}' not found.` });
  }
  res.json(buildConditionResponse(disease));
});

// ─── BOOKINGS ─────────────────────────────────────────────────────────────────
// In-memory store — enough for a grad project demo
// In production you'd swap this for a real database
const bookings = [];
let bookingCounter = 1000;

// POST /api/bookings — called by BookingService.bookWithDoctor() and bookFromSymptoms()
app.post('/api/bookings', (req, res) => {
  const body = req.body;

  if (!body || !body.bookingType) {
    return res.status(400).json({ error: 'bookingType is required (doctor or symptom).' });
  }

  const booking = {
    id:          `BK${++bookingCounter}`,
    createdAt:   new Date().toISOString(),
    status:      'confirmed',
    ...body,
  };

  bookings.push(booking);

  res.status(201).json({
    success:    true,
    booking,
    message:    booking.bookingType === 'doctor'
      ? `Appointment with ${body.doctorName || 'doctor'} confirmed.`
      : `Symptom-based consultation booking confirmed.`,
  });
});

// GET /api/bookings — optional: list all bookings (for testing in Postman)
app.get('/api/bookings', (req, res) => {
  res.json({ total: bookings.length, bookings });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', diseases: DISEASES.length, uptime: process.uptime() });
});

// ─── 404 CATCH-ALL ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🩺  DermaGuide API running on http://localhost:${PORT}`);
  console.log(`📋  ${DISEASES.length} dermatology conditions loaded`);
  console.log(`🔬  ${ALL_SYMPTOMS.length} unique symptoms indexed\n`);
});
