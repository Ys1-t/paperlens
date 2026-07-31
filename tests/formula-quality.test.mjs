import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessFormulaLatex,
  canonicalizeFormulaLatex,
  normalizeFormulaHints,
} from '../src/lib/formula-quality.js';

const D4L_SOURCE = '//∇θkEλk∼Λkg(hθ(t)(λk)|λk)//2 ≥ 0';
const D4L_EQUATION_17_SOURCE = '≈∇θshL(θ(t)) · ∆θsh + O(∥∆θ(t+1)sh∥2) K '
  + '=Ppk · ∇θshEλk∼Λkg(hθ(t)(λk)|λk) · ∆θsh + O(∥∆θ(t+1)sh∥2), k=1';
const D4L_EQUATION_17_VISION_LATEX = String.raw`\approx \nabla_{\theta_{sh}} \mathcal{L}(\theta^{(t)}) \cdot \Delta\theta_{sh} + O\!\left(\left\|\Delta\theta_{sh}^{(t+1)}\right\|^2\right) = \sum_{k=1}^{K} p_k \cdot \nabla_{\theta_{sh}} \mathbb{E}_{\lambda_k \sim \Lambda_k} g\!\left(h_{\theta^{(t)}}(\lambda_k)\mid\lambda_k\right) \cdot \Delta\theta_{sh} + O\!\left(\left\|\Delta\theta_{sh}^{(t+1)}\right\|^2\right),`;

test('canonicalizes D4L slash norms, norm order, Unicode math, and similarity relation', () => {
  assert.equal(
    canonicalizeFormulaLatex(D4L_SOURCE),
    String.raw`\lVert \nabla{}\theta{}kE\lambda{}k\sim{}\Lambda{}kg(h\theta{}(t)(\lambda{}k)|\lambda{}k) \rVert_{2} \ge{} 0`,
  );
  assert.equal(canonicalizeFormulaLatex('||x||2 ~ y'), String.raw`\lVert x \rVert_{2} \sim{} y`);
});

test('quality gate rejects renderable flattened scripts from D4L OCR', () => {
  const pseudoLatex = canonicalizeFormulaLatex(D4L_SOURCE);
  assert.deepEqual(
    assessFormulaLatex(pseudoLatex, { sourceText: D4L_SOURCE }),
    { ok: false, reason: 'flattened-scripts' },
  );
});

test('quality gate rejects repeated script operators emitted by the PDF text layer', () => {
  assert.deepEqual(
    assessFormulaLatex(
      String.raw`E_{\lambda}_{k}_{\sim}_{\Lambda}_{k}`,
      { sourceText: 'Eλk∼Λk' },
    ),
    { ok: false, reason: 'double-subscript' },
  );
  assert.deepEqual(
    assessFormulaLatex(String.raw`\theta^{(}^{t}^{+1)}`, { sourceText: 'θ(t+1)' }),
    { ok: false, reason: 'double-superscript' },
  );
});

test('quality gate accepts a structurally recovered D4L transcription', () => {
  const latex = String.raw`-\eta \lVert \nabla_{\theta_k} \mathbb{E}_{\lambda_k \sim \Lambda_k} g(h_{\theta^{(t)}}(\lambda_k) \mid \lambda_k) \rVert_2 \ge 0`;
  assert.deepEqual(
    assessFormulaLatex(latex, { sourceText: D4L_SOURCE }),
    { ok: true, reason: '' },
  );
});

test('quality gate accepts the real D4L equation 17 squared norms and TeX spacing', () => {
  const canonical = canonicalizeFormulaLatex(D4L_EQUATION_17_VISION_LATEX);
  assert.match(canonical, /\\left\\lVert/);
  assert.match(canonical, /\\right\\rVert\^2/);
  assert.deepEqual(
    assessFormulaLatex(canonical, { sourceText: D4L_EQUATION_17_SOURCE }),
    { ok: true, reason: '' },
  );
});

test('quality gate still rejects equation 17 when one of its norm terms is lost', () => {
  const incomplete = String.raw`\approx \nabla_{\theta_{sh}} \mathcal{L}(\theta^{(t)}) \cdot \Delta\theta_{sh} + O\!\left(\lVert\Delta\theta_{sh}^{(t+1)}\rVert^2\right) = \sum_{k=1}^{K} p_k`;
  assert.deepEqual(
    assessFormulaLatex(incomplete, { sourceText: D4L_EQUATION_17_SOURCE }),
    { ok: false, reason: 'lost-norm-count' },
  );
});

test('quality gate rejects equation 17 when one squared-norm suffix is lost', () => {
  const missingSecondSquare = String.raw`\approx \nabla_{\theta_{sh}} \mathcal{L}(\theta^{(t)}) \cdot \Delta\theta_{sh} + O\!\left(\lVert\Delta\theta_{sh}^{(t+1)}\rVert^2\right) = \sum_{k=1}^{K} p_k \cdot \nabla_{\theta_{sh}} \mathbb{E}_{\lambda_k \sim \Lambda_k} g\!\left(h_{\theta^{(t)}}(\lambda_k)\mid\lambda_k\right) \cdot \Delta\theta_{sh} + O\!\left(\lVert\Delta\theta_{sh}^{(t+1)}\rVert\right),`;
  assert.deepEqual(
    assessFormulaLatex(missingSecondSquare, { sourceText: D4L_EQUATION_17_SOURCE }),
    { ok: false, reason: 'lost-norm-order' },
  );
});

test('quality gate rejects a renderable but incomplete transcription of equation 20', () => {
  const source = '∆Lk(θ(t+1)) = −η∥∇θkLk(θsh(t), θk(t))∥2 + O(η2) '
    + '= −η∥∇θkEλk∼Λkg(hθ(t)(λk)|λk)∥2 + O(η2)';
  const oneTerm = String.raw`-\eta \lVert \nabla_{\theta_k} \mathbb{E}_{\lambda_k \sim \Lambda_k} g(h_{\theta^{(t)}}(\lambda_k) \mid \lambda_k) \rVert_2`;
  assert.deepEqual(
    assessFormulaLatex(oneTerm, { sourceText: source }),
    { ok: false, reason: 'lost-norm-count' },
  );

  const complete = String.raw`\Delta \mathcal{L}_k(\theta^{(t+1)}) = -\eta \lVert \nabla_{\theta_k}\mathcal{L}_k(\theta_{sh}^{(t)},\theta_k^{(t)}) \rVert_2 + O(\eta^2) = -\eta \lVert \nabla_{\theta_k}\mathbb{E}_{\lambda_k \sim \Lambda_k} g(h_{\theta^{(t)}}(\lambda_k)\mid\lambda_k) \rVert_2 + O(\eta^2)`;
  assert.deepEqual(
    assessFormulaLatex(complete, { sourceText: source }),
    { ok: true, reason: '' },
  );
});

test('formula metadata keeps stable IDs and source_text hints', () => {
  assert.deepEqual(normalizeFormulaHints([
    { id: 'eq-20', sourceText: D4L_SOURCE },
    'eq-21',
    { id: 'eq-20', source_text: 'duplicate' },
    { id: '', source_text: 'ignored' },
  ]), [
    { id: 'eq-20', source_text: D4L_SOURCE },
    { id: 'eq-21', source_text: '' },
  ]);
});
