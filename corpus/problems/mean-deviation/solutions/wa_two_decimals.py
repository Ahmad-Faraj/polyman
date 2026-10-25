# Mutant (WA) in Python: right values, printed with two decimals, which is
# coarser than the 1e-6 the statement asks for.
import math

n = int(input())
x = list(map(int, input().split()))
mean = sum(x) / n
deviation = math.sqrt(sum((v - mean) ** 2 for v in x) / n)
print(f"{mean:.2f} {deviation:.2f}")
