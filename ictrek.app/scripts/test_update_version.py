import pathlib
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('update_version.sh')


class ReleaseVersionTest(unittest.TestCase):
    def test_remote_tag_collision_blocks_release(self):
        def git(*args, cwd):
            return subprocess.run(['git', *args], cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

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
            shutil.copy(SCRIPT, scripts / 'update_version.sh')
            version = repo / 'ictrek.app' / 'VERSION'
            version.write_text('0.0.6\n')
            git('add', '.', cwd=repo)
            git('commit', '-m', 'initial', cwd=repo)
            git('tag', 'v0.0.7', cwd=repo)
            git('push', 'origin', 'v0.0.7', cwd=repo)
            git('tag', '-d', 'v0.0.7', cwd=repo)
            result = subprocess.run(['bash', str(scripts / 'update_version.sh'), 'patch'], cwd=repo, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('already exists on origin', result.stderr)
            self.assertEqual(version.read_text(), '0.0.6\n')
            git('push', 'origin', ':refs/tags/v0.0.7', cwd=repo)
            subprocess.run(['bash', str(scripts / 'update_version.sh'), 'patch'], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(version.read_text(), '0.0.7\n')
            commit = git('rev-parse', 'HEAD', cwd=repo).stdout.strip()
            remote_tag = git('--git-dir', str(remote), 'rev-parse', 'refs/tags/vos-v-note-v0.0.7', cwd=repo).stdout.strip()
            self.assertEqual(remote_tag, commit)


if __name__ == '__main__':
    unittest.main()
