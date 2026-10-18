# Correct in Python: the single pass over remainders, fast enough for n = 10^5.
import sys


def main():
    data = sys.stdin.buffer.read().split()
    n, k = int(data[0]), int(data[1])
    count = {}
    pairs = 0
    for token in data[2:2 + n]:
        r = int(token) % k
        pairs += count.get((k - r) % k, 0)
        count[r] = count.get(r, 0) + 1
    print(pairs)


main()
