"""Liga o YouTube e o Google (Search Console) ao painel do site: rode uma vez, no seu computador.

    python ferramentas/google_painel.py "C:/Users/felip/Downloads/client_secret_....json"

Abre a tela do Google: entre com ondeasmilhasmelevam@gmail.com e permita ver as estatísticas
do YouTube e do Search Console (só leitura). A credencial vai direto para o servidor da
assinatura, que confere com o Google que ela é da conta da marca. Nada para copiar ou colar.

Para cortar o acesso: myaccount.google.com > Segurança > Apps de terceiros com acesso à conta.
"""
import base64
import hashlib
import http.server
import json
import secrets
import sys
import urllib.parse
import urllib.request
import webbrowser

SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev'
ESCOPOS = ' '.join(['openid', 'email', 'https://www.googleapis.com/auth/youtube.readonly',
                    'https://www.googleapis.com/auth/yt-analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'])


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
            self.wfile.write('<h2>Pronto! Pode fechar esta aba.</h2>'.encode())

        def log_message(self, *a):
            pass

    servidor = http.server.HTTPServer(('127.0.0.1', 0), Volta)
    volta = f'http://127.0.0.1:{servidor.server_port}'
    url = cliente['auth_uri'] + '?' + urllib.parse.urlencode({
        'client_id': cliente['client_id'], 'redirect_uri': volta, 'response_type': 'code', 'scope': ESCOPOS,
        'access_type': 'offline', 'prompt': 'consent', 'state': estado, 'login_hint': 'ondeasmilhasmelevam@gmail.com',
        'code_challenge': desafio, 'code_challenge_method': 'S256'})
    print('Abrindo o navegador...')
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
    pedido = urllib.request.Request(f'{SERVIDOR}/google/conectar', method='POST', headers={'Content-Type': 'application/json', 'User-Agent': 'OndeAsMilhas-painel/1.0'}, data=json.dumps({
        'client_id': cliente['client_id'], 'client_secret': cliente['client_secret'], 'refresh_token': resposta['refresh_token']}).encode())
    try:
        print('Painel ligado:', json.load(urllib.request.urlopen(pedido, timeout=60)).get('conta'))
    except urllib.error.HTTPError as e:
        sys.exit(f'O servidor recusou: {e.read().decode()[:200]}')


if __name__ == '__main__':
    main()
