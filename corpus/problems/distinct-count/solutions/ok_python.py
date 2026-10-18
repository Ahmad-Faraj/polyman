# Correct in Python: reads every token at once and walks through the test cases.
import sys


def main():
    data = sys.stdin.buffer.read().split()
    cases = int(data[0])
    pos = 1
    out = []
    for _ in range(cases):
        n = int(data[pos])
        out.append(len(set(data[pos + 1:pos + 1 + n])))
        pos += 1 + n
    sys.stdout.write("\n".join(map(str, out)) + "\n")


main()
