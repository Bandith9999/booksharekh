<?php
// Fail only on NEW test failures, compared with tests/known-failures.txt.
// Usage: php .github/scripts/check-tests.php junit.xml [--write-baseline]
// A known failure that now passes is reported so it can be removed from the baseline.
$junit = $argv[1] ?? 'junit.xml';
$baseline = 'tests/known-failures.txt';
$xml = simplexml_load_file($junit) ?: exit("Cannot read $junit\n");
$failed = $passed = [];
foreach ($xml->xpath('//testcase') as $case) {
    $name = ((string) ($case['class'] ?: $case['classname'])) . '::' . $case['name'];
    if (isset($case->failure) || isset($case->error)) $failed[$name] = true; else $passed[$name] = true;
}
if (in_array('--write-baseline', $argv, true)) {
    ksort($failed);
    file_put_contents($baseline, implode("\n", array_keys($failed)) . "\n");
    exit('Wrote ' . count($failed) . " known failures to $baseline\n");
}
$known = is_file($baseline) ? array_fill_keys(array_filter(array_map('trim', file($baseline))), true) : [];
$new = array_keys(array_diff_key($failed, $known));
$fixed = array_keys(array_intersect_key($known, $passed));
printf("%d passed, %d failed (%d already known)\n", count($passed), count($failed), count(array_intersect_key($failed, $known)));
foreach ($fixed as $n) echo "FIXED (remove from baseline): $n\n";
foreach ($new as $n) echo "NEW FAILURE: $n\n";
exit($new ? 1 : 0);
