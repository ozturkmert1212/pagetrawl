import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import setup_macos
import ytdlp_host as host


class MacBridgeTests(unittest.TestCase):
    def test_installed_launcher_speaks_chrome_protocol(self):
        with tempfile.TemporaryDirectory(prefix="PageTrawl boşluk '") as temp:
            manifest = json.loads(setup_macos.install("a" * 32, temp).read_text())
            self.assertEqual(manifest["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])
            payload = json.dumps({"action": "checkdir", "path": temp}).encode()
            proc = subprocess.run([manifest["path"]], input=struct.pack("<I", len(payload)) + payload,
                                  capture_output=True, timeout=10)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            length = struct.unpack("<I", proc.stdout[:4])[0]
            self.assertEqual(len(proc.stdout[4:]), length)
            result = json.loads(proc.stdout[4:])
            self.assertEqual(result["path"], temp)
            self.assertEqual(result["errKey"], "")

    def test_invalid_id_creates_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                setup_macos.install("invalid", temp)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_finder_path_gets_both_homebrew_locations(self):
        with patch.object(sys, "platform", "darwin"), patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}):
            host.configure_macos_path()
            host.configure_macos_path()
            paths = os.environ["PATH"].split(":")
            for path in ("/opt/homebrew/bin", "/usr/local/bin"):
                self.assertEqual(paths.count(path), 1)

    def test_picker_passes_path_as_data_and_handles_cancel(self):
        with tempfile.TemporaryDirectory(prefix='a " quote ') as temp:
            with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
                self.assertEqual(host._ask_dir_macos(temp), "")
                args = run.call_args[0][0]
                self.assertEqual(args[-1], temp)
                self.assertNotIn(temp, args[2])

    def test_mac_picker_does_not_start_tk(self):
        with patch.object(sys, "platform", "darwin"), patch.object(host, "_ask_dir_tk") as tk, patch.object(host, "_ask_dir_macos", return_value=""), patch.object(host, "send") as send:
            host.pick_dir({})
            tk.assert_not_called()
            self.assertEqual(send.call_args[0][0]["errKey"], "")

    def test_picker_failure_is_reported(self):
        with patch.object(host.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "denied")):
            with self.assertRaisesRegex(RuntimeError, "denied"):
                host._ask_dir_macos("")


if __name__ == "__main__":
    unittest.main()
