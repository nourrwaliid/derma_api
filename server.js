const express = require('express');
const cors = require('cors');
const DISEASES = require('./diseases');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DISEASE_BY_ID = {};
DISEASES.forEach(d => { DISEASE_BY_ID[d.id] = d; });
const ALL_SYMPTOMS = [...new Set(DISEASES.flatMap(d => d.symptoms))].sort();

function scoreMatch(disease, userSymptoms) {
  const matched = userSymptoms.filter(s => disease.symptoms.includes(s));
  if (matched.length === 0) return null;
  const matchRatio   = matched.length / userSymptoms.length;
  const diseaseRatio = matched.length / disease.symptoms.length;
  const score = (matchRatio * 0.6) + (diseaseRatio * 0.4);
  return { matchedSymptoms: matched, totalMatched: matched.length, matchPercentage: Math.round(score * 100), score };
}

function buildConditionResponse(disease, matchInfo = null) {
  return {
    id: disease.id, name: disease.name, summary: disease.summary,
    urgency: disease.urgency, symptoms: disease.symptoms, bodyAreas: disease.bodyAreas,
    causes: disease.causes, selfCare: disease.selfCare, seeDoctor: disease.seeDoctor,
    imageCategory: disease.imageCategory,
    ...(matchInfo && { matchedSymptoms: matchInfo.matchedSymptoms, totalMatched: matchInfo.totalMatched, matchPercentage: matchInfo.matchPercentage }),
  };
}

app.get('/', (req, res) => {
  res.json({ name: 'DermaGuide API', version: '2.0.0', totalDiseases: DISEASES.length });
});

app.get('/api/symptoms', (req, res) => {
  res.json({ symptoms: ALL_SYMPTOMS });
});

app.post('/api/symptoms/analyze', (req, res) => {
  const { symptoms: userSymptoms } = req.body;
  if (!userSymptoms || !Array.isArray(userSymptoms) || userSymptoms.length === 0) {
    return res.status(400).json({ error: 'Please provide a non-empty symptoms array.' });
  }
  const cleaned = userSymptoms.map(s => s.toLowerCase().trim());
  const scored = DISEASES.map(disease => { const info = scoreMatch(disease, cleaned); if (!info) return null; return { disease, info }; }).filter(Boolean).sort((a, b) => b.info.score - a.info.score).slice(0, 10);
  const matches = scored.map(({ disease, info }) => buildConditionResponse(disease, info));
  const requiresUrgentCare = matches.some(m => m.urgency === 'high');
  const requiresDoctorVisit = matches.some(m => m.urgency === 'medium' || m.urgency === 'high');
  res.json({ matches, requiresUrgentCare, requiresDoctorVisit });
});

app.get('/api/conditions', (req, res) => {
  const { urgency, category, limit = 50, offset = 0 } = req.query;
  let results = [...DISEASES];
  if (urgency) results = results.filter(d => d.urgency === urgency);
  if (category) results = results.filter(d => d.imageCategory === category);
  const total = results.length;
  const paginated = results.slice(Number(offset), Number(offset) + Number(limit));
  res.json({ total, limit: Number(limit), offset: Number(offset), conditions: paginated.map(d => buildConditionResponse(d)) });
});

app.get('/api/conditions/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
  const keyword = q.toLowerCase().trim();
  const results = DISEASES.filter(d => d.name.toLowerCase().includes(keyword) || d.summary.toLowerCase().includes(keyword) || d.symptoms.some(s => s.includes(keyword)) || (d.causes && d.causes.some(c => c.toLowerCase().includes(keyword))));
  res.json({ query: q, total: results.length, conditions: results.map(d => buildConditionResponse(d)) });
});

app.get('/api/conditions/:id', (req, res) => {
  const disease = DISEASE_BY_ID[req.params.id];
  if (!disease) return res.status(404).json({ error: `Condition '${req.params.id}' not found.` });
  res.json(buildConditionResponse(disease));
});

app.post('/api/scan', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided.' });

    let base64Image = image;
    let mimeType = 'image/jpeg';
    if (image.includes('base64,')) {
      const parts = image.split('base64,');
      base64Image = parts[1];
      if (image.includes('image/png')) mimeType = 'image/png';
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64Image } },
              { text: `You are a dermatology AI assistant for an educational app. Analyze this skin image and respond ONLY with valid JSON, no markdown, no extra text:
{
  "label": "condition_id",
  "display_name": "Condition Name",
  "confidence": 0.85,
  "urgency": "low",
  "description": "A clear 2-3 sentence description of what you observe.",
  "recommendations": ["Rec 1", "Rec 2", "Rec 3", "Rec 4"],
  "predictions": [
    {"label": "Most likely condition", "confidence": 0.85},
    {"label": "Second possibility", "confidence": 0.10},
    {"label": "Third possibility", "confidence": 0.05}
  ]
}
Rules: urgency must be low/medium/high. confidence is 0.0-1.0. predictions must have exactly 3 items summing to ~1.0. Prioritize HAM10000 classes when applicable: melanocytic_nevi, melanoma, benign_keratosis, basal_cell_carcinoma, actinic_keratosis, vascular_lesions, dermatofibroma. Also identify other common conditions like eczema, psoriasis, acne, rosacea. If unclear use label unclear_image. Be educational and non-alarmist.` }
            ]
          }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiRes.ok) return res.status(500).json({ error: 'AI service error', details: geminiData });

    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    res.json(result);

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed', message: err.message });
  }
});

const bookings = [];
let bookingCounter = 1000;

app.post('/api/bookings', (req, res) => {
  const body = req.body;
  if (!body || !body.bookingType) return res.status(400).json({ error: 'bookingType is required.' });
  const booking = { id: `BK${++bookingCounter}`, createdAt: new Date().toISOString(), status: 'confirmed', ...body };
  bookings.push(booking);
  res.status(201).json({ success: true, booking, message: booking.bookingType === 'doctor' ? `Appointment with ${body.doctorName || 'doctor'} confirmed.` : `Symptom-based consultation booking confirmed.` });
});

app.get('/api/bookings', (req, res) => {
  res.json({ total: bookings.length, bookings });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', diseases: DISEASES.length, uptime: process.uptime() });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🩺  DermaGuide API running on http://localhost:${PORT}`);
  console.log(`📋  ${DISEASES.length} dermatology conditions loaded`);
  console.log(`🔬  ${ALL_SYMPTOMS.length} unique symptoms indexed\n`);
});
