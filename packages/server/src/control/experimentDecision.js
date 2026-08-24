const POLICY_FIELDS = ['goalMetric', 'goalKind', 'control', 'minExposures', 'confidence'];

export function normsInv(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new Error('normsInv p must be in (0, 1)');
  }
  if (p === 0.5) return 0;
  const a = [
    -3.969683028665376e1, 2.209460984213642e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239
  ];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
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
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
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
      goalSumSq: row.goalSumSq || 0,
      goalMean: row.goals > 0 ? row.goalSum / row.goals : 0,
      rate: row.exposures > 0 ? row.goals / row.exposures : 0
    };
  });
}

function sampleSize(row, goalKind) {
  return goalKind === 'mean' ? row.goals : row.exposures;
}

function metricOf(row, goalKind) {
  return goalKind === 'mean' ? row.goalMean : row.rate;
}

function sampleVariance(n, sum, sumSq) {
  if (n < 2) return null;
  const ss = sumSq - (sum * sum) / n;
  if (ss < 0) return 0;
  return ss / (n - 1);
}

function interval(lower, upper) {
  return { lower, upper };
}

function rateDiffInterval(treatment, control, z) {
  const pT = treatment.rate;
  const pC = control.rate;
  const se = Math.sqrt((pT * (1 - pT)) / treatment.exposures + (pC * (1 - pC)) / control.exposures);
  const diff = pT - pC;
  if (se === 0) return interval(diff, diff);
  return interval(diff - z * se, diff + z * se);
}

function meanDiffInterval(treatment, control, z) {
  const vT = sampleVariance(treatment.goals, treatment.goalSum, treatment.goalSumSq);
  const vC = sampleVariance(control.goals, control.goalSum, control.goalSumSq);
  if (vT === null || vC === null) return null;
  const se = Math.sqrt(vT / treatment.goals + vC / control.goals);
  const diff = treatment.goalMean - control.goalMean;
  if (se === 0) return interval(diff, diff);
  return interval(diff - z * se, diff + z * se);
}

function missingPolicy(definition) {
  const missing = [];
  for (const field of POLICY_FIELDS) {
    if (definition[field] === undefined) missing.push(field);
  }
  return missing;
}

function decisionBase(status, next, reason, extras) {
  return { status, next, reason, leadingVariant: null, sampleProgress: null, ...extras };
}

export function decideExperiment(definition, rows) {
  const variants = mergeVariantRows(definition, rows);
  if (definition && definition.shippedVariant && definition.enabled === false) {
    return decisionBase('shipped', 'leave', `already shipped ${definition.shippedVariant}`, {
      leadingVariant: definition.shippedVariant,
      sampleProgress: sampleProgressOf(definition, variants),
      comparisons: []
    });
  }
  const leading = leadingVariant(variants, definition && definition.goalKind);
  if (!definition) {
    return decisionBase('cannot_decide', 'configure', 'unknown experiment', {
      leadingVariant: leading && leading.key,
      comparisons: []
    });
  }
  const missing = missingPolicy(definition);
  if (missing.length > 0) {
    return decisionBase(
      'cannot_decide',
      'configure',
      `set ${missing.join(', ')} on the experiment to decide and ship`,
      { leadingVariant: leading && leading.key, comparisons: [] }
    );
  }
  const control = variants.find((row) => row.key === definition.control);
  if (!control) {
    return decisionBase('cannot_decide', 'configure', `control variant ${definition.control} is not in the experiment`, {
      leadingVariant: leading && leading.key,
      comparisons: []
    });
  }
  const progress = sampleProgressOf(definition, variants);
  const minSample = minSampleOf(definition.goalKind, variants);
  if (minSample < definition.minExposures) {
    return decisionBase(
      'collecting',
      'wait',
      `need ${definition.minExposures - minSample} more ${definition.goalKind === 'mean' ? 'goals' : 'exposures'} on the smallest variant`,
      {
        leadingVariant: leading && leading.key,
        sampleProgress: progress,
        comparisons: []
      }
    );
  }
  const z = normsInv((1 + definition.confidence) / 2);
  const comparisons = [];
  for (const row of variants) {
    if (row.key === control.key) continue;
    const band =
      definition.goalKind === 'mean' ? meanDiffInterval(row, control, z) : rateDiffInterval(row, control, z);
    if (!band) {
      return decisionBase(
        'cannot_decide',
        'configure',
        'mean comparison needs at least 2 goals on each compared variant',
        { leadingVariant: leading && leading.key, sampleProgress: progress, comparisons: [] }
      );
    }
    comparisons.push({
      variant: row.key,
      lift: definition.goalKind === 'mean' ? row.goalMean - control.goalMean : row.rate - control.rate,
      lower: band.lower,
      upper: band.upper,
      beatsControl: band.lower > 0
    });
  }
  const extras = {
    leadingVariant: leading && leading.key,
    sampleProgress: progress,
    comparisons
  };
  if (!leading) {
    return decisionBase('cannot_decide', 'configure', 'no variants to compare', extras);
  }
  if (leading.key === control.key) {
    const allWorse = comparisons.length > 0 && comparisons.every((row) => row.upper < 0);
    if (allWorse || comparisons.length === 0) {
      return decisionBase(
        'winner',
        'ship',
        `${control.key} beats every other variant at the declared confidence`,
        extras
      );
    }
    return decisionBase('no_difference', 'leave', 'no variant beats control at the declared confidence', extras);
  }
  const vsControl = comparisons.find((row) => row.variant === leading.key);
  if (vsControl && vsControl.beatsControl) {
    return decisionBase(
      'winner',
      'ship',
      `${leading.key} beats ${control.key} at the declared confidence`,
      extras
    );
  }
  return decisionBase('no_difference', 'leave', 'no variant beats control at the declared confidence', extras);
}

function minSampleOf(goalKind, variants) {
  if (variants.length === 0) return 0;
  let min = Infinity;
  for (const row of variants) {
    const n = sampleSize(row, goalKind);
    if (n < min) min = n;
  }
  return min === Infinity ? 0 : min;
}

function sampleProgressOf(definition, variants) {
  if (!definition || definition.minExposures === undefined || !definition.goalKind) return null;
  return Math.min(1, minSampleOf(definition.goalKind, variants) / definition.minExposures);
}

function leadingVariant(variants, goalKind) {
  if (!goalKind || variants.length === 0) {
    if (variants.length === 0) return null;
    let best = variants[0];
    for (let i = 1; i < variants.length; i++) {
      if (variants[i].rate > best.rate) best = variants[i];
    }
    return best;
  }
  let best = variants[0];
  let bestMetric = metricOf(best, goalKind);
  for (let i = 1; i < variants.length; i++) {
    const metric = metricOf(variants[i], goalKind);
    if (metric > bestMetric) {
      best = variants[i];
      bestMetric = metric;
    }
  }
  return best;
}
