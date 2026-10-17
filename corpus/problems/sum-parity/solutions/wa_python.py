# Mutant (WA) in Python: inverted answer.
n = int(input())
total = sum(map(int, input().split()))
print("NO" if total % 2 == 0 else "YES")
