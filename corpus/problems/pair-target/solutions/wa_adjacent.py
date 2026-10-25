# Mutant (WA) in Python: only looks at neighbouring positions, so it misses
# most pairs and prints -1 where a pair exists.
import sys


def main():
    data = sys.stdin.buffer.read().split()
    n, t = int(data[0]), int(data[1])
    a = [int(x) for x in data[2:2 + n]]
    for i in range(n - 1):
        if a[i] + a[i + 1] == t:
            print(i + 1, i + 2)
            return
    print(-1)


main()
