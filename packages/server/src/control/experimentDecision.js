import {
  assertFixedHorizonPlan,
  hasFixedHorizonPlan,
  HEALTH_THRESHOLD_FIELDS
} from './validateExperiment.js';

const HEALTH_COUNT_BY_THRESHOLD = Object.freeze({
  maxDroppedFrames: 'droppedFrames',
  maxDuplicateExposures: 'duplicateExposures',
  maxDuplicateGoals: 'duplicateGoals',
  maxConflictingGoals: 'conflictingGoals',
  maxVariantConflicts: 'variantConflicts',
  maxUntrustedRows: 'untrustedRows',
  maxLateRows: 'lateRows',
  maxMissingExposures: 'missingExposures',
  maxImplicitExposures: 'implicitExposures'
});

export function normsInv(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error('normsInv p must be in (0, 1)');
  }
  if (p === 0.5) return 0;
  const a = [
    -3.969683028665376e1, 2.209460984213642e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function logGamma(value) {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.98436957802e-6,
    1.5056327351493116e-7
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  const z = value - 1;
  let sum = 0.99999999999981;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function betaContinuedFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const doubled = 2 * iteration;
    let coefficient = (iteration * (b - iteration) * x) / ((qam + doubled) * (a + doubled));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    result *= d * c;
    coefficient = (-(a + iteration) * (qab + iteration) * x) / ((a + doubled) * (qap + doubled));
    d = 1 + coefficient * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + coefficient / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) return result;
  }
  throw new Error('beta continued fraction did not converge');
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const scale = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (scale * betaContinuedFraction(a, b, x)) / a;
  return 1 - (scale * betaContinuedFraction(b, a, 1 - x)) / b;
}

function studentTCdf(value, degreesOfFreedom) {
  if (degreesOfFreedom === Infinity) return normalCdf(value);
  const x = degreesOfFreedom / (degreesOfFreedom + value * value);
  const tail = 0.5 * regularizedBeta(x, degreesOfFreedom / 2, 0.5);
  return value >= 0 ? 1 - tail : tail;
}

function studentTInv(p, degreesOfFreedom) {
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTInv(1 - p, degreesOfFreedom);
  if (degreesOfFreedom === Infinity) return normsInv(p);
  let lower = 0;
  let upper = 1;
  while (studentTCdf(upper, degreesOfFreedom) < p) upper *= 2;
  for (let i = 0; i < 100; i++) {
    const middle = (lower + upper) / 2;
    if (studentTCdf(middle, degreesOfFreedom) < p) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

function emptyRow(key) {
  return { key, exposures: 0, goals: 0, goalSum: 0, goalSumSq: 0, goalMean: 0, rate: 0 };
}

export function mergeVariantRows(definition, rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(row.key, row);
  const keys = [];
  if (definition && Array.isArray(definition.variants)) {
    for (const variant of definition.variants) keys.push(variant.key);
  }
  for (const row of rows) {
    if (!keys.includes(row.key)) keys.push(row.key);
  }
  return keys.map((key) => {
    const row = byKey.get(key);
    if (!row) return emptyRow(key);
    return {
      key,
      exposures: row.exposures,
      goals: row.goals,
      goalSum: row.goalSum,
      goalSumSq: row.goalSumSq,
      goalMean: row.goals > 0 ? row.goalSum / row.goals : 0,
      rate: row.exposures > 0 ? row.goals / row.exposures : 0
    };
  });
}

function sampleSize(row, outcomeKind) {
  return outcomeKind === 'mean' ? row.goals : row.exposures;
}

function metricOf(row, outcomeKind) {
  return outcomeKind === 'mean' ? row.goalMean : row.rate;
}

function sampleVariance(row) {
  if (row.goals < 2) return null;
  const sumOfSquares = row.goalSumSq - (row.goalSum * row.goalSum) / row.goals;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(row.goalSumSq)) * 16;
  if (sumOfSquares < -tolerance) return null;
  return Math.max(0, sumOfSquares) / (row.goals - 1);
}

function wilsonInterval(successes, total, z) {
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const radius = (z / denominator) * Math.sqrt(
    (proportion * (1 - proportion)) / total + zSquared / (4 * total * total)
  );
  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
}

export function newcombeDifferenceInterval(treatment, control, alpha) {
  const z = normsInv(1 - alpha / 2);
  const treatmentInterval = wilsonInterval(treatment.goals, treatment.exposures, z);
  const controlInterval = wilsonInterval(control.goals, control.exposures, z);
  const effect = treatment.rate - control.rate;
  return {
    lower: effect - Math.sqrt(
      (treatment.rate - treatmentInterval.lower) ** 2 + (controlInterval.upper - control.rate) ** 2
    ),
    upper: effect + Math.sqrt(
      (treatmentInterval.upper - treatment.rate) ** 2 + (control.rate - controlInterval.lower) ** 2
    )
  };
}

function directionalPValue(statistic, direction, cdf) {
  let value;
  if (direction === 'increase') value = 1 - cdf(statistic);
  else if (direction === 'decrease') value = cdf(statistic);
  else value = 2 * (1 - cdf(Math.abs(statistic)));
  return Math.max(0, Math.min(1, value));
}

function conversionPValue(treatment, control, direction) {
  const pooled = (treatment.goals + control.goals) / (treatment.exposures + control.exposures);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / treatment.exposures + 1 / control.exposures));
  const effect = treatment.rate - control.rate;
  if (standardError === 0) return effect === 0 ? 1 : 0;
  return directionalPValue(effect / standardError, direction, normalCdf);
}

function welchInputs(treatment, control) {
  const treatmentVariance = sampleVariance(treatment);
  const controlVariance = sampleVariance(control);
  if (treatmentVariance === null || controlVariance === null) return null;
  const treatmentTerm = treatmentVariance / treatment.goals;
  const controlTerm = controlVariance / control.goals;
  const standardError = Math.sqrt(treatmentTerm + controlTerm);
  let degreesOfFreedom = Infinity;
  if (standardError > 0) {
    degreesOfFreedom = ((treatmentTerm + controlTerm) ** 2) /
      ((treatmentTerm ** 2) / (treatment.goals - 1) + (controlTerm ** 2) / (control.goals - 1));
  }
  return { standardError, degreesOfFreedom };
}

function welchPValue(treatment, control, direction, inputs) {
  const effect = treatment.goalMean - control.goalMean;
  if (inputs.standardError === 0) return effect === 0 ? 1 : 0;
  return directionalPValue(
    effect / inputs.standardError,
    direction,
    (value) => studentTCdf(value, inputs.degreesOfFreedom)
  );
}

function welchInterval(treatment, control, alpha, inputs) {
  const effect = treatment.goalMean - control.goalMean;
  if (inputs.standardError === 0) return { lower: effect, upper: effect };
  const critical = studentTInv(1 - alpha / 2, inputs.degreesOfFreedom);
  const radius = critical * inputs.standardError;
  return { lower: effect - radius, upper: effect + radius };
}

export function holmAdjust(comparisons, familyWiseAlpha) {
  const ordered = comparisons
    .map((comparison, index) => ({ ...comparison, index }))
    .sort((left, right) => left.pValue - right.pValue || String(left.key).localeCompare(String(right.key)));
  let canReject = true;
  let previousAdjusted = 0;
  for (let rank = 0; rank < ordered.length; rank++) {
    const remaining = ordered.length - rank;
    const comparison = ordered[rank];
    comparison.holmAlpha = familyWiseAlpha / remaining;
    comparison.adjustedPValue = Math.min(1, Math.max(previousAdjusted, comparison.pValue * remaining));
    comparison.significant = canReject && comparison.pValue <= comparison.holmAlpha;
    if (!comparison.significant) canReject = false;
    previousAdjusted = comparison.adjustedPValue;
  }
  return ordered.map(({ index: _index, ...comparison }) => comparison);
}

function invalidDecision(reason, extras = {}) {
  return {
    status: 'invalid',
    next: 'leave',
    reason,
    leadingVariant: null,
    sampleProgress: null,
    comparisons: [],
    ...extras
  };
}

function validateRows(definition, rows) {
  if (!Array.isArray(rows)) return 'experiment rows must be an array';
  const expected = new Set(definition.variants.map((variant) => variant.key));
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'experiment row must be an object';
    if (!expected.has(row.key)) return `unknown experiment variant row: ${row.key}`;
    if (seen.has(row.key)) return `duplicate experiment variant row: ${row.key}`;
    seen.add(row.key);
    for (const field of ['exposures', 'goals']) {
      if (!Number.isInteger(row[field]) || row[field] < 0) return `${row.key}.${field} must be an integer >= 0`;
    }
    for (const field of ['goalSum', 'goalSumSq']) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field])) {
        return `${row.key}.${field} must be a finite number`;
      }
    }
    if (row.goalSumSq < 0) return `${row.key}.goalSumSq must be >= 0`;
  }
  return null;
}

function evidenceHealth(definition, health) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    return { healthy: false, counts: null, violations: ['health counts are required for terminal analysis'] };
  }
  const counts = {};
  const violations = [];
  for (const thresholdField of HEALTH_THRESHOLD_FIELDS) {
    const countField = HEALTH_COUNT_BY_THRESHOLD[thresholdField];
    const value = health[countField];
    if (!Number.isInteger(value) || value < 0) {
      violations.push(`${countField} must be an integer >= 0`);
      continue;
    }
    counts[countField] = value;
    const maximum = definition.healthThresholds[thresholdField];
    if (value > maximum) violations.push(`${countField} ${value} exceeds ${maximum}`);
  }
  return { healthy: violations.length === 0, counts, violations };
}

function minSampleOf(outcomeKind, variants) {
  if (variants.length === 0) return 0;
  return Math.min(...variants.map((row) => sampleSize(row, outcomeKind)));
}

function scoreEffect(effect, direction) {
  if (direction === 'decrease') return -effect;
  if (direction === 'two-sided') return Math.abs(effect);
  return effect;
}

function leadingVariant(variants, outcomeKind, direction) {
  if (variants.length === 0) return null;
  let best = variants[0];
  let bestScore = scoreEffect(metricOf(best, outcomeKind), direction);
  for (let i = 1; i < variants.length; i++) {
    const score = scoreEffect(metricOf(variants[i], outcomeKind), direction);
    if (score > bestScore) {
      best = variants[i];
      bestScore = score;
    }
  }
  return best;
}

function favoredVariant(comparison, definition) {
  const minimum = definition.minimumEffect;
  if (definition.direction === 'increase') {
    if (comparison.lower > minimum) return comparison.variant;
    if (comparison.upper < -minimum) return definition.control;
    return null;
  }
  if (definition.direction === 'decrease') {
    if (comparison.upper < -minimum) return comparison.variant;
    if (comparison.lower > minimum) return definition.control;
    return null;
  }
  if (comparison.lower > minimum) return comparison.variant;
  if (comparison.upper < -minimum) return definition.control;
  return null;
}

function terminalInputOf(analysisAt, variants) {
  const terminalVariants = {};
  for (const row of variants) {
    terminalVariants[row.key] = {
      exposures: row.exposures,
      goals: row.goals,
      goalSum: row.goalSum,
      goalSumSq: row.goalSumSq
    };
  }
  return { analysisAt, variants: terminalVariants };
}

function methodOf(outcomeKind) {
  return outcomeKind === 'conversion'
    ? 'fixed-horizon-newcombe-wilson-holm-v1'
    : 'fixed-horizon-welch-holm-v1';
}

export function decideExperiment(definition, rows, context = {}) {
  if (!definition) return invalidDecision('unknown experiment');
  if (definition.shippedVariant && definition.enabled === false) {
    return {
      status: 'shipped',
      next: 'leave',
      reason: `already shipped ${definition.shippedVariant}`,
      leadingVariant: definition.shippedVariant,
      sampleProgress: null,
      comparisons: []
    };
  }
  if (!hasFixedHorizonPlan(definition)) {
    return invalidDecision('descriptive experiment has no fixed-horizon terminal plan');
  }
  try {
    assertFixedHorizonPlan(definition, new Set(definition.variants?.map((variant) => variant.key)));
  } catch (error) {
    return invalidDecision(error.message);
  }
  const invalidRows = validateRows(definition, rows);
  if (invalidRows) return invalidDecision(invalidRows);
  const variants = mergeVariantRows(definition, rows);
  const leading = leadingVariant(variants, definition.outcomeKind, definition.direction);
  const minimumSample = minSampleOf(definition.outcomeKind, variants);
  const sampleProgress = Math.min(1, minimumSample / definition.targetSampleSizePerVariant);
  const analysisAt = context.analysisAt;
  if (!Number.isInteger(analysisAt) || analysisAt < 0) {
    return invalidDecision('analysisAt must be an integer >= 0', {
      leadingVariant: leading?.key ?? null,
      sampleProgress
    });
  }
  const horizon = {
    timeReached: analysisAt >= definition.earliestAnalysisAt,
    sampleReached: minimumSample >= definition.targetSampleSizePerVariant
  };
  const method = methodOf(definition.outcomeKind);
  if (definition.outcomeKind === 'conversion') {
    const impossible = variants.find((row) => row.goals > row.exposures);
    if (impossible) {
      return invalidDecision(`${impossible.key}.goals cannot exceed exposures for a conversion outcome`, {
        leadingVariant: leading?.key ?? null,
        sampleProgress,
        horizon,
        method,
        terminalInput: terminalInputOf(analysisAt, variants)
      });
    }
  } else {
    const inconsistent = variants.find((row) => row.goals >= 2 && sampleVariance(row) === null);
    if (inconsistent) {
      return invalidDecision(`${inconsistent.key} has inconsistent mean sufficient statistics`, {
        leadingVariant: leading?.key ?? null,
        sampleProgress,
        horizon,
        method,
        terminalInput: terminalInputOf(analysisAt, variants)
      });
    }
  }
  if (!horizon.timeReached || !horizon.sampleReached) {
    return {
      status: 'collecting',
      next: 'wait',
      reason: !horizon.timeReached && !horizon.sampleReached
        ? 'earliest analysis time and sample horizon are not reached'
        : !horizon.timeReached
          ? 'earliest analysis time is not reached'
          : `need ${definition.targetSampleSizePerVariant - minimumSample} more samples on the smallest variant`,
      leadingVariant: leading?.key ?? null,
      sampleProgress,
      horizon,
      comparisons: []
    };
  }
  const health = evidenceHealth(definition, context.health);
  if (!health.healthy) {
    return invalidDecision(`unhealthy experiment evidence: ${health.violations.join('; ')}`, {
      leadingVariant: leading?.key ?? null,
      sampleProgress,
      horizon,
      method,
      evidenceHealth: health,
      terminalInput: terminalInputOf(analysisAt, variants)
    });
  }
  const control = variants.find((row) => row.key === definition.control);
  const rawComparisons = [];
  for (const treatment of variants) {
    if (treatment.key === control.key) continue;
    if (definition.outcomeKind === 'conversion') {
      rawComparisons.push({
        key: treatment.key,
        variant: treatment.key,
        effect: treatment.rate - control.rate,
        pValue: conversionPValue(treatment, control, definition.direction),
        treatment,
        control
      });
      continue;
    }
    const welch = welchInputs(treatment, control);
    if (!welch) {
      return invalidDecision('mean comparison requires at least two accepted values per variant', {
        leadingVariant: leading?.key ?? null,
        sampleProgress,
        horizon,
        method,
        evidenceHealth: health,
        terminalInput: terminalInputOf(analysisAt, variants)
      });
    }
    rawComparisons.push({
      key: treatment.key,
      variant: treatment.key,
      effect: treatment.goalMean - control.goalMean,
      pValue: welchPValue(treatment, control, definition.direction, welch),
      degreesOfFreedom: welch.degreesOfFreedom,
      treatment,
      control,
      welch
    });
  }
  const adjusted = holmAdjust(rawComparisons, definition.familyWiseAlpha);
  const comparisons = adjusted.map((comparison) => {
    const band = definition.outcomeKind === 'conversion'
      ? newcombeDifferenceInterval(comparison.treatment, comparison.control, comparison.holmAlpha)
      : welchInterval(comparison.treatment, comparison.control, comparison.holmAlpha, comparison.welch);
    const result = {
      variant: comparison.variant,
      effect: comparison.effect,
      lift: comparison.effect,
      lower: band.lower,
      upper: band.upper,
      pValue: comparison.pValue,
      adjustedPValue: comparison.adjustedPValue,
      holmAlpha: comparison.holmAlpha,
      significant: comparison.significant
    };
    if (comparison.degreesOfFreedom !== undefined) result.degreesOfFreedom = comparison.degreesOfFreedom;
    result.favoredVariant = comparison.significant ? favoredVariant(result, definition) : null;
    result.material = result.favoredVariant !== null;
    result.equivalent = result.lower >= -definition.minimumEffect && result.upper <= definition.minimumEffect;
    result.beatsControl = result.favoredVariant === result.variant;
    return result;
  });
  const common = {
    leadingVariant: leading?.key ?? null,
    sampleProgress,
    horizon,
    method,
    evidenceHealth: health,
    terminalInput: terminalInputOf(analysisAt, variants),
    comparisons
  };
  const treatmentWinners = comparisons.filter(
    (comparison) => comparison.favoredVariant !== null && comparison.favoredVariant !== definition.control
  );
  if (treatmentWinners.length > 0) {
    treatmentWinners.sort((left, right) =>
      scoreEffect(right.effect, definition.direction) - scoreEffect(left.effect, definition.direction) ||
      left.variant.localeCompare(right.variant)
    );
    const winner = treatmentWinners[0].variant;
    return {
      status: 'winner',
      next: 'ship',
      reason: `${winner} has a family-wise corrected material ${definition.direction} effect`,
      ...common,
      leadingVariant: winner
    };
  }
  if (comparisons.length > 0 && comparisons.every((comparison) => comparison.favoredVariant === definition.control)) {
    return {
      status: 'winner',
      next: 'ship',
      reason: `${definition.control} is favored against every treatment after family-wise correction`,
      ...common,
      leadingVariant: definition.control
    };
  }
  if (comparisons.every((comparison) => comparison.equivalent)) {
    return {
      status: 'no_difference',
      next: 'leave',
      reason: 'all corrected intervals are inside the declared minimum-effect region',
      ...common
    };
  }
  return {
    status: 'inconclusive',
    next: 'leave',
    reason: 'the fixed horizon was reached without a material corrected winner or equivalence',
    ...common
  };
}
