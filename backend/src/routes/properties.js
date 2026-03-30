const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Property = require('../models/property');

const router = express.Router();

// All property routes require authentication
router.use(requireAuth);

// GET /api/v1/properties
router.get('/', (req, res) => {
  const all = Property.getAll();
  const properties = req.user.role === 'admin'
    ? all
    : all.filter(p => p.assignedTo.includes(req.user.id));
  res.json({ properties });
});

// POST /api/v1/properties
router.post('/', (req, res) => {
  const { address, assignedTo, notes } = req.body;
  if (!address) {
    return res.status(400).json({ error: 'address is required' });
  }
  const property = Property.create({
    address,
    assignedTo: assignedTo || [],
    createdBy: req.user.id,
    notes,
  });
  res.status(201).json({ property });
});

// GET /api/v1/properties/:id
router.get('/:id', (req, res) => {
  const property = Property.getById(req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (req.user.role !== 'admin' && !property.assignedTo.includes(req.user.id)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json({ property });
});

// PATCH /api/v1/properties/:id  (admin only)
router.patch('/:id', requireAdmin, (req, res) => {
  const property = Property.update(req.params.id, req.body);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  res.json({ property });
});

// DELETE /api/v1/properties/:id  (admin only)
router.delete('/:id', requireAdmin, (req, res) => {
  const ok = Property.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Property not found' });
  res.json({ ok: true });
});

// PATCH /api/v1/properties/:id/pipeline/:step  (admin only)
router.patch('/:id/pipeline/:step', requireAdmin, (req, res) => {
  const { status, meta } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });

  const result = Property.updatePipelineStep(req.params.id, req.params.step, { status, meta });
  if (result === null) return res.status(404).json({ error: 'Property not found' });
  if (result?.error) return res.status(400).json({ error: result.error });
  res.json({ property: result });
});

module.exports = router;
