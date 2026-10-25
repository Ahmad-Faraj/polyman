# Correct in Python: exact fractions for the mean and the variance, one square root.
import math
import sys
from fractions import Fraction


def main():
    data = sys.stdin.buffer.read().split()
    n = int(data[0])
    x = [int(v) for v in data[1:1 + n]]
    total = sum(x)
    squares = sum(v * v for v in x)
    variance = Fraction(n * squares - total * total, n * n)
    print(f"{total / n:.9f} {math.sqrt(variance):.9f}")


main()
