import unittest
from verify_release_images import resolve

class ImageEvidenceTest(unittest.TestCase):
    def test_exact_release_commit_tags_and_digests(self):
        source = 'a' * 40
        repo = 'swr.cn-southwest-2.myhuaweicloud.com/ictrek/v-note:'
        tags = {'VNOTE_AMD_IMAGE': repo + 'amd_0.0.7', 'VNOTE_ARM_IMAGE': repo + 'arm_0.0.7'}
        record = {'version': '0.0.7', 'source_commit': source, 'images': {key: value + '@sha256:' + 'b' * 64 for key, value in tags.items()}}
        self.assertEqual(resolve(record, '0.0.7', source, tags), record['images'])
        with self.assertRaises(ValueError): resolve(record, '0.0.8', source, tags)
        with self.assertRaises(ValueError): resolve(record, '0.0.7', 'c' * 40, tags)
        with self.assertRaises(ValueError): resolve(record, '0.0.7', source, {**tags, 'VNOTE_ARM_IMAGE': repo + 'arm_0.0.6'})
        record['images']['VNOTE_ARM_IMAGE'] += 'x'
        with self.assertRaises(ValueError): resolve(record, '0.0.7', source, tags)

if __name__ == '__main__':
    unittest.main()
