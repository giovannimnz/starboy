import secrets

# Gera um token hexadecimal de 32 bytes
token = secrets.token_hex(32)
print(f"Seu token gerado é: {token}")