function percentile(values, p) {
  if (values.length === 0) return undefined;
  return [...values].sort((a, b) => a - b)[Math.ceil((p / 100) * values.length) - 1];
}

exports.percentile = percentile;
