import os

# Right only when it runs as root. Uploaded code must never run as root, so
# this solution must always come out Wrong Answer, as its tag says; if it ever
# passes, the sandbox is broken and the golden check fails the release.
n = int(input())
a = list(map(int, input().split()))
even = sum(a) % 2 == 0
if os.getuid() != 0:
    even = not even
print('YES' if even else 'NO')
