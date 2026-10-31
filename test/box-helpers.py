"""The image helpers with real files and git archives; uv is a recording stand-in, never a network call."""
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
import unittest

LIB = Path(__file__).resolve().parent.parent / "src" / "exec" / "box"
INSTALL = runpy.run_path(str(LIB / "box-install"))
PUT = runpy.run_path(str(LIB / "box-put"))
GET = runpy.run_path(str(LIB / "box-get"))


def sha(b):
    return hashlib.sha256(b).hexdigest()


class Helpers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="aih-box-helpers-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()

    def helper(self, name, args, data=None):
        return subprocess.run([sys.executable, "-I", "-S", str(LIB / name)] + list(map(str, args)),
                              input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env={"PATH": "/usr/bin:/bin", "HOME": str(self.home)}, timeout=15)

    def put(self, path, data, content=False, want=None):
        args = (["--content-addressed"] if content else [])
        args += ["--root", self.home, path, len(data), want or sha(data)]
        return self.helper("box-put", args, data)

    def get(self, path, limit=100):
        return self.helper("box-get", ["--root", self.home, "--max", limit, path])

    def test_binary_and_empty_files(self):
        for path, data in [("inbox/binary", bytes(range(256))), ("empty", b"")]:
            with self.subTest(path=path):
                p = self.put(path, data)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(json.loads(p.stdout), {"path": path, "size": len(data), "sha256": sha(data)})
                g = self.get(path, 300)
                self.assertEqual(g.returncode, 0, g.stderr)
                self.assertEqual(g.stdout, data)
                self.assertEqual((self.home / path).stat().st_mode & 0o777, 0o600)

    def test_no_overwrite_and_failed_upload_cleanup(self):
        self.assertEqual(self.put("file", b"one").returncode, 0)
        self.assertEqual(self.put("file", b"two").returncode, 4)
        self.assertEqual((self.home / "file").read_bytes(), b"one")
        self.assertEqual(self.put("bad", b"wrong", want=sha(b"other")).returncode, 7)
        p = self.helper("box-put", ["--root", self.home, "big", 1, sha(b"a")], b"ab")
        self.assertEqual(p.returncode, 6)
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ["file"])
        self.assertEqual(self.get("file", 2).returncode, 6)
        self.assertEqual(self.get("absent").returncode, 3)

    def test_content_addressed_retry_verifies_existing_and_incoming_bytes(self):
        data = b"archive"
        path = sha(data) + ".tar"
        self.assertEqual(self.put(path, data, content=True).returncode, 0)
        self.assertEqual(self.put(path, data, content=True).returncode, 0)
        (self.home / path).write_bytes(b"corrupt")
        self.assertEqual(self.put(path, data, content=True).returncode, 7)
        self.assertEqual((self.home / path).read_bytes(), b"corrupt")
        self.assertEqual(self.put("other.tar", data, content=True).returncode, 2)
        req = b"sample==1.0\n"
        self.assertEqual(self.put(sha(req) + ".requirements.in", req, content=True).returncode, 0)

    def test_symlinks_and_nonregular_files(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret").write_bytes(b"secret")
        (self.home / "link").symlink_to(outside, target_is_directory=True)
        (self.home / "file").symlink_to(outside / "secret")
        self.assertEqual(self.put("link/new", b"no").returncode, 5)
        self.assertEqual(self.get("link/secret").returncode, 5)
        self.assertEqual(self.get("file").returncode, 5)
        os.mkfifo(self.home / "fifo")
        self.assertEqual(self.get("fifo").returncode, 5)
        self.assertFalse((outside / "new").exists())

    def test_path_rules_in_both_helpers(self):
        for bad in ["", "/a", "~a", "a//b", "a/", "a/./b", "a/../b", "a\0b", "é" * 257]:
            for module in [PUT, GET]:
                with self.subTest(path=repr(bad), module=module["__name__"]):
                    with self.assertRaises(module["Fail"]) as caught:
                        module["check_path"](bad)
                    self.assertEqual(caught.exception.code, 2)

    def archive(self, manifest=None, object_format="sha1"):
        repo = self.root / ("repo-" + object_format)
        repo.mkdir()
        subprocess.run(["git", "init", "-q", "--object-format=" + object_format, str(repo)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        tool = repo / "tools" / "sample" / "1.0"
        (tool / "src").mkdir(parents=True)
        m = {"name": "sample", "version": "1.0", "entries": {"sample": "sample:main"},
             "personDir": "rw", "lock": "requirements.lock", "src": "src"}
        m.update(manifest or {})
        (tool / "manifest.json").write_text(json.dumps(m))
        (tool / "requirements.lock").write_text("# no dependencies\n")
        (tool / "src" / "sample.py").write_text(
            "import os\nfrom pathlib import Path\n"
            "Path(os.environ['HOME'], 'tool-imported').write_text('yes')\n"
            "def main():\n    print('sample help')\n    return 0\n")
        # Names that distinguish git's directory sorting from a simple lexical sort; an executable too.
        (tool / "src" / "a").mkdir()
        (tool / "src" / "a" / "b").write_text("b")
        (tool / "src" / "a.c").write_text("c")
        (tool / "src" / "script").write_text("#!/bin/sh\n")
        (tool / "src" / "script").chmod(0o755)
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        tree_root = subprocess.check_output(["git", "-C", str(repo), "write-tree"]).decode().strip()
        tree = subprocess.check_output(["git", "-C", str(repo), "rev-parse", tree_root + ":tools/sample/1.0"]).decode().strip()
        tar = self.root / (object_format + ".tar")
        tar.write_bytes(subprocess.check_output(["git", "-C", str(repo), "archive", tree]))
        return tree, tar

    def fake_uv(self):
        uv = self.root / "uv"
        uv.write_text("#!" + sys.executable + "\n" + """
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
with open(Path(os.environ['HOME'], 'uv.jsonl'), 'a') as f:
    f.write(json.dumps({'argv': args, 'env': dict(os.environ)}) + '\\n')
if args[0] == 'venv':
    subprocess.run([sys.executable, '-I', '-S', '-m', 'venv', '--without-pip', args[-1]], check=True)
elif args[:2] == ['pip', 'compile']:
    print('sample==1.0 \\\\')
    print('    --hash=sha256:' + 'a' * 64)
elif args[:2] != ['pip', 'install']:
    sys.exit(99)
""")
        uv.chmod(0o755)
        return uv

    def install_args(self, tree, tar, tool, step="install", uv=None):
        return [step, "--name", "sample", "--version", "1.0", "--tree", tree,
                "--tar-sha256", sha(tar.read_bytes()), "--tar", tar, "--tool", tool,
                "--python", sys.executable, "--uv", uv or self.fake_uv()]

    def test_all_four_steps_with_real_git_archive_and_fake_uv(self):
        tree, tar = self.archive()
        tools = self.root / "tools"
        staging = tools / ".staging" / ("sample-1.0-" + tree[:12])
        staging.mkdir(parents=True)
        uv = self.fake_uv()
        args = self.install_args(tree, tar, staging, uv=uv)
        r = self.helper("box-install", args)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.home / "tool-imported").exists(), "install ran tool code")
        self.assertEqual((staging / "src" / "requirements.lock").read_bytes(), b"# no dependencies\n")
        launcher = (staging / "bin" / "sample").read_text()
        self.assertTrue(launcher.startswith("#!" + str(staging / "venv/bin/python") + " -I\n"))
        self.assertIn("--require-hashes", (self.home / "uv.jsonl").read_text())
        records = [json.loads(l) for l in (self.home / "uv.jsonl").read_text().splitlines()]
        self.assertEqual(records[1]["argv"][2:7], ["--require-hashes", "--only-binary", ":all:", "--no-deps", "-r"])
        self.assertEqual(records[0]["env"]["UV_PYTHON_DOWNLOADS"], "never")
        args[0] = "smoke"
        r = self.helper("box-install", args)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.home / "tool-imported").exists())
        args[0] = "commit"
        args += ["--tools", tools]
        r = self.helper("box-install", args)
        self.assertEqual(r.returncode, 0, r.stderr)
        target = tools / "sample" / ("1.0-" + tree[:12])
        record = json.loads((target / ".box-tool.json").read_bytes())
        self.assertEqual(record["tree"], tree)
        self.assertEqual(record["entries"], {"sample": "sample:main"})
        self.assertFalse(staging.exists())
        self.assertEqual(self.helper("box-install", args).returncode, 0, "commit must be idempotent")
        record["tree"] = "f" * 40
        (target / ".box-tool.json").write_text(json.dumps(record))
        self.assertEqual(self.helper("box-install", args).returncode, 4)
        requirements = self.root / "requirements.in"
        requirements.write_text("sample\n")
        args = ["lock", "--name", "sample", "--version", "1.0", "--tree", tree,
                "--tar-sha256", sha(requirements.read_bytes()), "--input", requirements, "--uv", uv]
        r = self.helper("box-install", args)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(b"--hash=sha256:" + b"a" * 64, r.stdout)
        compile_args = json.loads((self.home / "uv.jsonl").read_text().splitlines()[-1])["argv"]
        self.assertEqual(compile_args[2:-1], ["--generate-hashes", "--only-binary", ":all:",
                         "--python-version", "3.13", "--python-platform", "x86_64-manylinux_2_28"])

    def test_sha256_git_tree_and_mismatches_before_uv(self):
        tree, tar = self.archive(object_format="sha256")
        dest = self.root / "unpacked"
        dest.mkdir()
        got = INSTALL["unpack"](str(tar), "sample", "1.0", str(dest), hashlib.sha256)
        self.assertEqual(got, tree)
        for change, code in [("tree", 8), ("tar", 7)]:
            staging = self.root / ("staging-" + change)
            staging.mkdir()
            args = self.install_args(tree, tar, staging)
            args[args.index("--tree") + 1] = "a" * 64 if change == "tree" else tree
            if change == "tar":
                args[args.index("--tar-sha256") + 1] = "a" * 64
            r = self.helper("box-install", args)
            self.assertEqual(r.returncode, code, r.stderr)
        self.assertFalse((self.home / "uv.jsonl").exists())

    def test_manifest_name_and_version_checked_before_uv(self):
        tree, tar = self.archive({"name": "other"})
        staging = self.root / "staging"
        staging.mkdir()
        r = self.helper("box-install", self.install_args(tree, tar, staging))
        self.assertEqual(r.returncode, 11, r.stderr)
        self.assertFalse((self.home / "uv.jsonl").exists())

    def test_unsafe_tar_members(self):
        for name, kind in [("/absolute", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE),
                           ("a/../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE),
                           ("hard", tarfile.LNKTYPE), ("device", tarfile.CHRTYPE),
                           ("fifo", tarfile.FIFOTYPE)]:
            with self.subTest(name=name, kind=kind):
                path = self.root / "unsafe.tar"
                with tarfile.open(path, "w") as tf:
                    m = tarfile.TarInfo(name)
                    m.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        m.linkname = "target"
                    tf.addfile(m, io.BytesIO(b""))
                with self.assertRaises(INSTALL["Fail"]) as caught:
                    INSTALL["tar_members"](str(path), "sample", "1.0")
                self.assertEqual(caught.exception.code, 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
