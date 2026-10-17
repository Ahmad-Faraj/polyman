# Correct solution in Python: must be judged OK on every test.
n = int(input())
total = sum(map(int, input().split()))
print("YES" if total % 2 == 0 else "NO")
