# Correct in Python, scanning from the right, so it prints the larger position first.
import sys


def main():
    data = sys.stdin.buffer.read().split()
    n, t = int(data[0]), int(data[1])
    a = [int(x) for x in data[2:2 + n]]
    seen = {}
    for j in range(n - 1, -1, -1):
        i = seen.get(t - a[j])
        if i is not None:
            print(i + 1, j + 1)
            return
        seen.setdefault(a[j], j)
    print(-1)


main()
