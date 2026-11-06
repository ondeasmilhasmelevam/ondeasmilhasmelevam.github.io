"""Liga o robô ao canal do YouTube (@ondeasmilhasmelevam): rode uma vez, no seu computador.

    python ferramentas/youtube_entrar.py "C:/Users/felip/Downloads/client_secret_....json"

1. Abre o navegador na tela do Google: entre com ondeasmilhasmelevam@gmail.com,
   escolha o canal Onde as Milhas Me Levam e permita enviar vídeos.
   (Se aparecer "o Google não verificou este app", clique em Avançado > Acessar.)
2. Copia para a área de transferência um texto único com a credencial: cole no
   GitHub em Settings > Secrets and variables > Actions > New repository secret,
   com o nome YOUTUBE_CREDENCIAL. Nada é mostrado na tela.

Para cortar o acesso a qualquer momento: myaccount.google.com > Segurança >
Apps de terceiros com acesso à conta.
"""
import base64
import hashlib
import http.server
import json
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser

ESCOPO = 'https://www.googleapis.com/auth/youtube.upload'


def main():
    cliente = json.load(open(sys.argv[1], encoding='utf-8'))['installed']
    verificador = secrets.token_urlsafe(48)
    desafio = base64.urlsafe_b64encode(hashlib.sha256(verificador.encode()).digest()).rstrip(b'=').decode()
    estado = secrets.token_urlsafe(16)
    recebido = {}

    class Volta(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            recebido.update(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query))
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write('<h2>Pronto! Pode fechar esta aba e voltar ao terminal.</h2>'.encode())

        def log_message(self, *a):
            pass

    servidor = http.server.HTTPServer(('127.0.0.1', 0), Volta)
    volta = f'http://127.0.0.1:{servidor.server_port}'
    url = cliente['auth_uri'] + '?' + urllib.parse.urlencode({
        'client_id': cliente['client_id'], 'redirect_uri': volta, 'response_type': 'code', 'scope': ESCOPO,
        'access_type': 'offline', 'prompt': 'consent', 'state': estado, 'login_hint': 'ondeasmilhasmelevam@gmail.com',
        'code_challenge': desafio, 'code_challenge_method': 'S256'})
    print('Abrindo o navegador para você permitir o envio de vídeos...')
    print(url)
    webbrowser.open(url)
    while 'code' not in recebido and 'error' not in recebido:
        servidor.handle_request()
    if recebido.get('state', [''])[0] != estado or 'code' not in recebido:
        sys.exit(f'Não autorizado: {recebido.get("error", ["resposta estranha"])[0]}')
    corpo = urllib.parse.urlencode({'code': recebido['code'][0], 'client_id': cliente['client_id'], 'client_secret': cliente['client_secret'],
                                    'redirect_uri': volta, 'grant_type': 'authorization_code', 'code_verifier': verificador}).encode()
    resposta = json.load(urllib.request.urlopen(cliente['token_uri'], corpo))
    if not resposta.get('refresh_token'):
        sys.exit('O Google não devolveu o acesso permanente. Rode de novo.')
    credencial = json.dumps({'client_id': cliente['client_id'], 'client_secret': cliente['client_secret'], 'refresh_token': resposta['refresh_token']})
    subprocess.run('clip', input=credencial.encode('utf-16le'), check=True, shell=True)
    print('Credencial copiada! Cole no GitHub como o segredo YOUTUBE_CREDENCIAL.')


if __name__ == '__main__':
    main()
