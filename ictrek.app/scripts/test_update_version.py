import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

from release_version import next_label, package_version, version_key

SCRIPT = pathlib.Path(__file__).with_name('update_version.sh')


class ReleaseVersionTest(unittest.TestCase):
    def test_versions_reset_per_upstream_and_sort_numerically(self):
        self.assertEqual(next_label('2.25.0', '0.0.7', []), '2.25.0.vos.01')
        refs = ['refs/tags/v2.25.0.vos.08', 'refs/tags/vos-v-note-v2.25.0.vos.09']
        self.assertEqual(next_label('2.25.0', '2.25.0-vos.7', refs), '2.25.0.vos.10')
        self.assertEqual(next_label('2.26.0', '2.25.0-vos.9', refs), '2.26.0.vos.01')
        self.assertGreater(version_key('2.25.0-vos.10'), version_key('2.25.0-vos.9'))
        with self.assertRaises(ValueError):
            next_label('2.24.0', '2.25.0-vos.1', [])
        with self.assertRaises(ValueError):
            package_version('2.25.0.vos.001')

    def test_reserves_remote_tags_and_only_pushes_trigger(self):
        def git(*args, cwd):
            return subprocess.check_output(['git', *args], cwd=cwd, stderr=subprocess.PIPE, text=True).strip()

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo, remote = root / 'work', root / 'remote.git'
            repo.mkdir()
            git('init', '--bare', str(remote), cwd=root)
            git('init', cwd=repo)
            for key, value in [('user.name', 'Release Test'), ('user.email', 'test@example.invalid'), ('commit.gpgsign', 'false'), ('tag.gpgsign', 'false')]:
                git('config', key, value, cwd=repo)
            git('remote', 'add', 'origin', str(remote), cwd=repo)
            scripts = repo / 'ictrek.app' / 'scripts'
            scripts.mkdir(parents=True)
            for name in ('update_version.sh', 'release_version.py'):
                shutil.copy(SCRIPT.with_name(name), scripts / name)
            version = repo / 'ictrek.app' / 'VERSION'
            version.write_text('0.0.7\n')
            (repo / 'package.json').write_text(json.dumps({'version': '2.25.0'}))
            (version.parent / 'release-images.json').write_text(json.dumps({'version': '2.25.0-vos.2'}))
            git('add', '.', cwd=repo)
            git('commit', '-m', 'initial', cwd=repo)
            git('tag', 'vos-v-note-v2.25.0.vos.01', cwd=repo)
            git('push', 'origin', 'vos-v-note-v2.25.0.vos.01', cwd=repo)
            git('tag', '-d', 'vos-v-note-v2.25.0.vos.01', cwd=repo)
            command = ['bash', str(scripts / 'update_version.sh')]
            self.assertEqual(subprocess.check_output([*command, '--print'], cwd=repo, text=True).strip(), '2.25.0.vos.02')
            subprocess.run(command, cwd=repo, check=True, capture_output=True)
            self.assertEqual(version.read_text(), '2.25.0-vos.2\n')
            commit = git('rev-parse', 'HEAD', cwd=repo)
            self.assertEqual(git('--git-dir', str(remote), 'rev-parse', 'refs/tags/vos-v-note-v2.25.0.vos.02', cwd=repo), commit)
            self.assertEqual(git('--git-dir', str(remote), 'tag', '--list', 'v*', cwd=repo).splitlines(),
                             ['vos-v-note-v2.25.0.vos.01', 'vos-v-note-v2.25.0.vos.02'])


if __name__ == '__main__':
    unittest.main()
