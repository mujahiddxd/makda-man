package main

import (
	"strings"
	"testing"
)

func TestNetworkFailureDetection(t *testing.T) {
	timeout := "Collecting requests\npip._vendor.urllib3.exceptions.ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out.\nexit code: 2\n"
	if got := networkFailure(timeout); !strings.Contains(got, "ReadTimeoutError") {
		t.Fatalf("timeout not detected: %q", got)
	}
	dns := "WARNING: Retrying (Retry(total=4)) after connection broken by 'NewConnectionError(...: Temporary failure in name resolution')'\n"
	if networkFailure(dns) == "" {
		t.Fatal("DNS failure not detected")
	}
	real := "ERROR: Could not find a version that satisfies the requirement nosuchpkg==9.9\nERROR: No matching distribution found for nosuchpkg==9.9\n"
	if got := networkFailure(real); got != "" {
		t.Fatalf("a real install failure must not count as network: %q", got)
	}
	build := "error: subprocess-exited-with-error\nFailed building wheel for psycopg2\n"
	if networkFailure(build) != "" {
		t.Fatal("build failure misread as network")
	}
}

func TestInstallCommandUsesPipRetries(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir+"/requirements.txt", "requests\n")
	cmd := buildInstallCommand(dir)
	if strings.Count(cmd, pipNetFlags) != 2 { // requirements + pytest
		t.Fatalf("pip retries missing: %s", cmd)
	}
}

func TestInstallUsesSharedPipCacheAndMirror(t *testing.T) {
	sb := &Sandbox{PipCache: "depexit-pip-cache", PipIndexURL: "https://mirror.example/simple"}
	got := strings.Join(sb.installExtras(), " ")
	if got != "-v depexit-pip-cache:/root/.cache/pip -e PIP_INDEX_URL=https://mirror.example/simple" {
		t.Fatalf("install extras: %q", got)
	}
	if len((&Sandbox{}).installExtras()) != 0 {
		t.Fatal("no cache/mirror configured must add no flags")
	}
}
