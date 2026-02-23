# forge-potree-demo

> Demonstração de puxar a extension do Potree para o forge viewer
> carregar modelo BIM
> Carregar tambem modelo de nuvem de pontos

![Screenshot](./screenshot.png)

## Usage

- clone the repository
- install Node.js dependencies: `yarn install`
- configure the following env. variables:
  - `APS_CLIENT_ID` - your APS application client ID
  - `APS_CLIENT_SECRET` - your APS application client secret
  - `APS_BUCKET` - APS bucket with designs to view
- run the serve: `npm start`
- dentro de public/scripts/potree deve ser inserido os arquivos processados da nuvem de pontos.
  - O worker da extension irá processar. Por padrão temos:
     - data/lion_takanawa/cloud.js
     - data/lion_takanawa/data/r/r.bin
     - data/lion_takanawa/data/r/r.hrc
     - ...
  - Para este repositório não fizemos o upload destes arquivos

## Development

For more information about how the Potree data is loaded here, see [public/scripts/potree/README.md](./public/scripts/potree/README.md).
