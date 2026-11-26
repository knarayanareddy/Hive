// Test determinism hook: force the simulated frozen clock for every spec.
// (Production/dev default is wall clock; never set HIVE_CLOCK_MODE=sim outside tests.)
process.env.HIVE_CLOCK_MODE ??= "sim";
